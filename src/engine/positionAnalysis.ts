/**
 * Position Analysis: collapse every open position on one ticker into a single
 * P&L-vs-spot curve, valued as of any date between today and the last
 * expiration in the book.
 *
 * The whole page rests on one identity:
 *
 *     P&L(S, asOf) = bookValue(S, T_remaining) - entryValue
 *
 * `bsPrice` already returns intrinsic at T <= 0, so a leg that has expired by
 * the selected date settles at its kink and a leg that is still alive keeps its
 * time value — with no branch between the two cases. "Today", "at the September
 * expiry" and "at the last expiry" are the same code path with a different
 * `asOf`, which is what makes the Robinhood-style date bar cheap.
 *
 * Aggregation by ticker composes correctly for free: a `cc` row carries only
 * the written call (see the cc case in monteCarlo.payoffAtPrices), so the
 * covering shares row supplies the stock leg exactly once.
 */
import { RISK_FREE_RATE, bsPrice, type OptionType } from "./blackScholes";
import { openingCashFlow } from "./cashFlow";
import { spreadLegs } from "./spread";
import { dteDays } from "./trade";
import type { Trade } from "@/types";

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365;

/** Where a leg's vol and greeks came from. Surfaced as the LV/BS tag. */
export type ValuationSource = "live" | "model" | "exact";

/** One tradable option leg of a position. `side` is +1 long, -1 short. */
export interface OptionLeg {
  strike: number;
  cp: OptionType;
  side: 1 | -1;
}

/**
 * The option legs a position actually holds.
 *
 * Mirrors the branch structure of blackScholes.theoreticalValue exactly — that
 * function is Sum(side * bsPrice * mult) for every trade type, so anything
 * derived from this list (quotes to request, live greeks to sum, per-leg
 * pricing) stays consistent with how the rest of the engine values the trade.
 */
export function optionLegsOf(trade: Trade): OptionLeg[] {
  const t = trade.trade_type;
  if (t === "shares") return [];
  const K1 = trade.strike ?? 0;

  if (t === "long_call") return K1 > 0 ? [{ strike: K1, cp: "call", side: 1 }] : [];
  if (t === "short_call" || t === "cc")
    return K1 > 0 ? [{ strike: K1, cp: "call", side: -1 }] : [];
  if (t === "long_put") return K1 > 0 ? [{ strike: K1, cp: "put", side: 1 }] : [];
  if (t === "short_put" || t === "csp")
    return K1 > 0 ? [{ strike: K1, cp: "put", side: -1 }] : [];

  const legs = spreadLegs(t, trade.strike, trade.strike_2);
  if (!legs) return [];
  const out: OptionLeg[] = [];
  if (legs.long != null) out.push({ strike: legs.long, cp: legs.kind, side: 1 });
  if (legs.short != null) out.push({ strike: legs.short, cp: legs.kind, side: -1 });
  return out;
}

/**
 * Value of the position at spot S with T years left, one vol per leg.
 *
 * The per-leg-vol generalization of theoreticalValue: with a single vol
 * repeated across the legs the two agree to the last cent for all eleven trade
 * types (asserted by scripts/parity check). Per-leg vol matters once live
 * quotes are in play — the two strikes of a spread sit at different points on
 * the skew and pricing both off one number moves the curve by real dollars.
 */
export function bookLegValue(
  trade: Trade,
  legs: OptionLeg[],
  ivs: number[],
  S: number,
  T: number,
  r = RISK_FREE_RATE,
): number {
  if (trade.trade_type === "shares") return S * trade.qty;
  const mult = 100 * trade.qty;
  let v = 0;
  for (let i = 0; i < legs.length; i++) {
    const iv = ivs[i];
    v += legs[i].side * bsPrice(S, legs[i].strike, T, iv, r, legs[i].cp) * mult;
  }
  return v;
}

/**
 * Cost of getting into the position, in the same sign convention as
 * bookLegValue — so `value - entryValue` is P&L.
 *
 * This is the negation of the ledger's opening cash flow, deliberately rather
 * than a second formula: the ledger already resolves credit-vs-debit from the
 * structure, discards the sign typed into the premium field, and falls back to
 * the mark for a share lot with no recorded basis. Deriving it here a second
 * time is how the chart and the cash ledger would drift apart.
 */
export function entryValue(trade: Trade): number {
  return -openingCashFlow(trade);
}

/** A position prepared for charting: legs, the vols in force, and provenance. */
export interface AnalysisLeg {
  trade: Trade;
  legs: OptionLeg[];
  /** Vol used to price each entry in `legs`, index-aligned. */
  ivs: number[];
  source: ValuationSource;
  entryValue: number;
  expiryMs: number | null;
  /** Share lot priced off the mark because no cost basis was recorded. */
  basisMissing: boolean;
}

/** The whole book for one ticker. */
export interface TickerBook {
  ticker: string;
  spot: number;
  legs: AnalysisLeg[];
  /** True when every option leg priced off a live quote. */
  allLive: boolean;
  /** Share lots contributing to the curve with no recorded cost basis. */
  basisMissing: Trade[];
}

/** Live quote for one contract, per share, as returned by the edge function. */
export interface LiveQuote {
  iv: number;
  delta: number;
  theta: number;
  vega: number;
  mid: number;
}

/** Stable key for a contract across the request, the response and lookups. */
export function quoteKey(
  ticker: string,
  expiration: string,
  strike: number,
  cp: OptionType,
): string {
  return `${ticker.toUpperCase()}|${expiration}|${strike.toFixed(2)}|${cp === "call" ? "C" : "P"}`;
}

/** Distinct tickers in a set of trades, alphabetical. */
export function tickersInBook(trades: Trade[]): string[] {
  return [...new Set(trades.map((t) => t.ticker.toUpperCase()))].sort();
}

/**
 * Assemble one ticker's book, preferring live vol per leg and falling back to
 * the vol stored on the trade.
 *
 * Fallback is per *position*, not per leg: pricing one strike of a spread off a
 * live quote and its partner off an entry-time vol would invent skew that isn't
 * there and show a tighter or wider spread than exists. A position is priced
 * live only when every one of its legs came back quoted.
 */
export function buildBook(
  trades: Trade[],
  ticker: string,
  quotes: Record<string, LiveQuote> | null,
): TickerBook {
  const sym = ticker.toUpperCase();
  const mine = trades.filter((t) => t.ticker.toUpperCase() === sym);

  const legs: AnalysisLeg[] = mine.map((trade) => {
    const optLegs = optionLegsOf(trade);
    const isShares = trade.trade_type === "shares";

    const live =
      quotes && trade.expiration && optLegs.length > 0
        ? optLegs.map((l) => quotes[quoteKey(sym, trade.expiration!, l.strike, l.cp)])
        : null;
    const allQuoted = !!live && live.every((q) => q && q.iv > 0);

    return {
      trade,
      legs: optLegs,
      ivs: allQuoted ? live!.map((q) => q.iv) : optLegs.map(() => trade.iv),
      source: isShares ? "exact" : allQuoted ? "live" : "model",
      entryValue: entryValue(trade),
      expiryMs: trade.expiration
        ? new Date(`${trade.expiration}T00:00:00`).getTime()
        : null,
      basisMissing: isShares && trade.cost_basis == null,
    };
  });

  // Every row of a ticker is repriced together by the market-data refresh, so
  // they agree; take the first that has one rather than averaging stale rows.
  const spot = mine.find((t) => (t.underlying_price ?? 0) > 0)?.underlying_price ?? 0;

  const optionLegs = legs.filter((l) => l.legs.length > 0);
  return {
    ticker: sym,
    spot,
    legs,
    allLive: optionLegs.length > 0 && optionLegs.every((l) => l.source === "live"),
    basisMissing: legs.filter((l) => l.basisMissing).map((l) => l.trade),
  };
}

/** A selectable point on the date bar under the chart. */
export interface AsOfDate {
  /** Epoch ms the book is valued at. */
  ms: number;
  /** ISO date, or null for "Today". */
  date: string | null;
  label: string;
  /** Calendar days from today. */
  daysOut: number;
}

/**
 * The date bar: today, then every distinct expiration in the book.
 *
 * Expirations are valued at 00:00 local — the same instant dteDays measures to
 * — so selecting an expiry lands exactly on that leg's kink rather than a few
 * hours short of it, which would leave a sliver of time value on a leg the user
 * is looking at precisely because it has expired.
 */
export function asOfDates(book: TickerBook, now = Date.now()): AsOfDate[] {
  const exps = [...new Set(book.legs.map((l) => l.trade.expiration).filter(Boolean))]
    .sort() as string[];

  const out: AsOfDate[] = [
    { ms: now, date: null, label: "Today", daysOut: 0 },
  ];
  for (const e of exps) {
    const ms = new Date(`${e}T00:00:00`).getTime();
    if (ms < now) continue; // already expired; its legs are settled either way
    out.push({
      ms,
      date: e,
      label: new Date(`${e}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
      daysOut: Math.round((ms - now) / MS_PER_DAY),
    });
  }
  return out;
}

/** Slider stops for the visible spot range, as +/- fractions of spot. */
export const RANGE_STOPS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4];

/** Never open tighter than this: a payoff curve needs room to show its shape. */
const MIN_DEFAULT_RANGE = 0.2;

/**
 * Default visible range: the tightest stop that still shows every strike's
 * kink, so a book whose strikes sit far from spot opens framed on its own
 * structure rather than on an arbitrary window.
 *
 * Floored, because "fits the strikes" alone is the wrong target for an
 * at-the-money position — a covered call written at spot needs no width at all
 * by that rule and would open at +/-5%, too zoomed to read. The floor only
 * ever widens the view; the slider still goes tighter on request.
 */
export function defaultRange(book: TickerBook): number {
  const S = book.spot;
  const strikes = book.legs.flatMap((l) => l.legs.map((g) => g.strike));
  if (S <= 0 || !strikes.length) return MIN_DEFAULT_RANGE;
  let need = MIN_DEFAULT_RANGE;
  for (const k of strikes) need = Math.max(need, Math.abs(k / S - 1) * 1.15);
  return RANGE_STOPS.find((r) => r >= need) ?? RANGE_STOPS[RANGE_STOPS.length - 1];
}

/** Spot grid for the x-axis, spanning +/- `range` around spot. */
export function priceGrid(book: TickerBook, range: number, points = 241): number[] {
  const S = book.spot;
  if (S <= 0) return [];
  const lo = Math.max(S * (1 - range), 0.01);
  const hi = S * (1 + range);
  const step = (hi - lo) / (points - 1);
  return Array.from({ length: points }, (_, i) => lo + step * i);
}

/** Aggregate P&L across the book at each price on the grid, valued at `asOfMs`. */
export function curveAt(book: TickerBook, asOfMs: number, prices: number[]): number[] {
  const out = new Array<number>(prices.length).fill(0);

  for (const leg of book.legs) {
    const T =
      leg.expiryMs == null
        ? 1 // shares never expire; T is unused for them
        : Math.max(0, (leg.expiryMs - asOfMs) / MS_PER_DAY / DAYS_PER_YEAR);

    for (let i = 0; i < prices.length; i++) {
      out[i] += bookLegValue(leg.trade, leg.legs, leg.ivs, prices[i], T) - leg.entryValue;
    }
  }
  return out;
}

/**
 * Where the aggregate curve crosses zero, by linear interpolation between grid
 * points. Scans the whole curve rather than solving per structure, so a book
 * with several breakevens (a strangle, or shares plus a spread) reports all of
 * them.
 */
export function breakevens(prices: number[], pnl: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < pnl.length; i++) {
    const a = pnl[i - 1];
    const b = pnl[i];
    if (a === 0) out.push(prices[i - 1]);
    else if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
      out.push(prices[i - 1] + ((prices[i] - prices[i - 1]) * -a) / (b - a));
    }
  }
  return out;
}

export interface CurveExtremes {
  maxProfit: number;
  maxLoss: number;
  /** Gain grows without bound as spot rises. */
  profitUncapped: boolean;
  /** Loss grows without bound as spot rises. */
  lossUncapped: boolean;
  /** Where the best case occurs, or null when it is unbounded. */
  profitAt: ExtremePoint | null;
  /** Where the worst case occurs, or null when it is unbounded. */
  lossAt: ExtremePoint | null;
}

export interface ExtremePoint {
  /** Label of the valuation date the extreme occurs on. */
  label: string;
  spot: number;
}

/**
 * Slope of the payoff once spot is far above every strike.
 *
 * Shares contribute their count; each call contributes 100 per contract, signed
 * by which way it is held. Puts and cash go flat. This holds before expiry too:
 * a deep-ITM call's delta tends to 1 whatever time is left, so the sign of this
 * number decides unboundedness at every valuation date, not only the last.
 */
function asymptoticSlope(book: TickerBook): number {
  let slope = 0;
  for (const leg of book.legs) {
    if (leg.trade.trade_type === "shares") {
      slope += leg.trade.qty;
      continue;
    }
    for (const g of leg.legs) {
      if (g.cp === "call") slope += g.side * 100 * leg.trade.qty;
    }
  }
  return slope;
}

/**
 * Best and worst P&L the book can reach, searched over spot AND over every
 * valuation date the page offers.
 *
 * Collapsing every leg to intrinsic is the wrong question for a diagonal. A
 * short call written against a long LEAPS is closed out when the short leg
 * expires, with years of extrinsic value still in the long -- so pricing both
 * at intrinsic reports a position that barely profits, when the actual trade
 * peaks at the short strike on the short expiry with the long still carrying
 * time value. The peak therefore has to be searched across dates, not just
 * across spot at one date.
 *
 * Away from expiry the curve is smooth rather than piecewise linear, so the
 * search is numerical: a dense sweep of spot, with every strike included
 * exactly. Peaks sit at strikes far more often than anywhere else -- that is
 * where the short leg's payoff bends -- and a sampled grid would otherwise
 * shave the top off the very number being reported.
 *
 * The sweep is deliberately independent of the range slider, so zooming the
 * chart cannot change what the position's best and worst cases are.
 *
 * Deliberately not built by summing trade.ts maxGain/maxLoss: those are
 * portfolio risk heuristics (a long call's max gain is 4x premium there, a cc's
 * max loss is 0 by convention), and summing per-trade worst cases would treat
 * legs as independent when the whole point here is that they are not.
 */
export function bookExtremes(book: TickerBook, dates: AsOfDate[]): CurveExtremes {
  const empty = {
    maxProfit: 0,
    maxLoss: 0,
    profitUncapped: false,
    lossUncapped: false,
    profitAt: null,
    lossAt: null,
  };
  if (!book.legs.length || book.spot <= 0 || !dates.length) return empty;

  const strikes = book.legs.flatMap((l) => l.legs.map((g) => g.strike));
  // Wide enough that the tails are flat well before the edge, so the sweep is
  // measuring the structure rather than where the sweep happened to stop.
  const hi = Math.max(book.spot * 3, ...strikes.map((k) => k * 1.5));
  const N = 1200;
  const sweep: number[] = [0, ...strikes];
  for (let i = 0; i <= N; i++) sweep.push((hi * i) / N);

  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  let profitAt: ExtremePoint | null = null;
  let lossAt: ExtremePoint | null = null;

  for (const d of dates) {
    const pnl = curveAt(book, d.ms, sweep);
    for (let i = 0; i < sweep.length; i++) {
      if (pnl[i] > maxProfit) {
        maxProfit = pnl[i];
        profitAt = { label: d.label, spot: sweep[i] };
      }
      if (pnl[i] < maxLoss) {
        maxLoss = pnl[i];
        lossAt = { label: d.label, spot: sweep[i] };
      }
    }
  }

  const slope = asymptoticSlope(book);
  // A fractional share cannot make a position unbounded; the tolerance keeps
  // floating-point dust in a balanced structure from reading as open risk.
  const profitUncapped = slope > 1e-9;
  const lossUncapped = slope < -1e-9;

  return {
    maxProfit: profitUncapped ? Infinity : maxProfit,
    maxLoss: lossUncapped ? -Infinity : maxLoss,
    profitUncapped,
    lossUncapped,
    profitAt: profitUncapped ? null : profitAt,
    lossAt: lossUncapped ? null : lossAt,
  };
}

export interface BookGreeks {
  delta: number;
  theta: number;
  vega: number;
  source: ValuationSource;
}

/**
 * Aggregate greeks for the book, live where the quotes reached, modelled
 * otherwise.
 *
 * Public quotes greeks per share, so a contract's contribution is scaled by
 * 100 * qty and signed by which way the leg is held — the same composition
 * bookLegValue uses, so the greeks and the curve describe one position.
 * `source` is "live" only when every option leg was quoted; a mixed book is
 * reported as modelled rather than as a live number it partly isn't.
 */
export function bookGreeks(
  book: TickerBook,
  quotes: Record<string, LiveQuote> | null,
  now = Date.now(),
): BookGreeks {
  let delta = 0;
  let theta = 0;
  let vega = 0;
  let anyModelled = false;
  let anyOption = false;

  for (const leg of book.legs) {
    if (leg.trade.trade_type === "shares") {
      delta += leg.trade.qty;
      continue;
    }
    anyOption = true;
    const mult = 100 * leg.trade.qty;

    if (leg.source === "live" && quotes && leg.trade.expiration) {
      for (const g of leg.legs) {
        const q = quotes[quoteKey(book.ticker, leg.trade.expiration, g.strike, g.cp)];
        delta += g.side * q.delta * mult;
        theta += g.side * q.theta * mult;
        vega += g.side * q.vega * mult;
      }
      continue;
    }

    // Modelled: finite differences on the same per-leg valuation the curve
    // uses, so a fallback leg's greeks are consistent with its drawn slope.
    anyModelled = true;
    const S = book.spot;
    const T = dteDays(leg.trade, now) / DAYS_PER_YEAR;
    const v = (s: number, t: number, bump: number) =>
      bookLegValue(leg.trade, leg.legs, leg.ivs.map((x) => x + bump), s, t);
    const v0 = v(S, T, 0);
    const ds = S * 0.01;
    if (ds > 0) delta += (v(S + ds, T, 0) - v0) / ds;
    theta += v(S, Math.max(0, T - 1 / DAYS_PER_YEAR), 0) - v0;
    vega += (v(S, T, 0.01) - v0) / (0.01 * 100);
  }

  return {
    delta,
    theta,
    vega,
    source: !anyOption ? "exact" : anyModelled ? "model" : "live",
  };
}

/** Total capital committed to the ticker, and current mark-to-model P&L. */
export function bookPosition(book: TickerBook, now = Date.now()) {
  let cost = 0;
  let value = 0;
  for (const leg of book.legs) {
    const T =
      leg.expiryMs == null
        ? 1
        : Math.max(0, (leg.expiryMs - now) / MS_PER_DAY / DAYS_PER_YEAR);
    cost += leg.entryValue;
    value += bookLegValue(leg.trade, leg.legs, leg.ivs, book.spot, T);
  }
  return { cost, value, pnl: value - cost };
}

/** Lognormal density of terminal price, for the probability shading. */
export function terminalDensity(
  book: TickerBook,
  asOf: AsOfDate,
  prices: number[],
): number[] {
  const S0 = book.spot;
  // Horizon vol: the book's own vol, weighted toward the legs with the most
  // contracts, so the shading reflects what this position is exposed to.
  let wIv = 0;
  let w = 0;
  for (const leg of book.legs) {
    if (!leg.ivs.length) continue;
    const q = Math.abs(leg.trade.qty);
    wIv += (leg.ivs.reduce((a, b) => a + b, 0) / leg.ivs.length) * q;
    w += q;
  }
  const iv = w > 0 ? wIv / w : 0;
  const T = Math.max(asOf.daysOut / DAYS_PER_YEAR, 1 / DAYS_PER_YEAR);
  const s = iv * Math.sqrt(T);
  if (S0 <= 0 || s <= 0) return prices.map(() => 0);

  const mu = Math.log(S0) - 0.5 * iv * iv * T;
  return prices.map((x) => {
    if (x <= 0) return 0;
    const z = (Math.log(x) - mu) / s;
    return Math.exp(-0.5 * z * z) / (x * s * Math.sqrt(2 * Math.PI));
  });
}
