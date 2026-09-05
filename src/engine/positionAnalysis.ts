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

/**
 * Spot grid for the x-axis: wide enough to show every strike's kink with room
 * past it, and never narrower than +/-35% of spot so a near-the-money book
 * still shows its shape.
 */
export function priceGrid(book: TickerBook, points = 241): number[] {
  const S = book.spot;
  if (S <= 0) return [];
  const strikes = book.legs.flatMap((l) => l.legs.map((g) => g.strike));
  let lo = S * 0.65;
  let hi = S * 1.35;
  for (const k of strikes) {
    lo = Math.min(lo, k * 0.88);
    hi = Math.max(hi, k * 1.12);
  }
  lo = Math.max(lo, 0.01);
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
  /** The curve is still climbing at the right edge — gain is uncapped. */
  profitUncapped: boolean;
  /** Still falling at the left edge, or climbing losses at the right. */
  lossUncapped: boolean;
}

/**
 * Best and worst P&L on the curve.
 *
 * Read off the computed curve, not by summing per-trade maxGain/maxLoss: those
 * are independent worst cases and a covered call's short leg would report an
 * infinite loss the shares underneath it cannot suffer.
 *
 * A grid is a window, so an extreme sitting on its edge is a floor on the real
 * number, not the number. Whether it is worth saying so is a question of
 * scale, not of slope: a covered call marked before expiry is still gaining a
 * cent per dollar at the top of the range as the short call's last time value
 * decays, and calling that "uncapped" would be true and useless. The test is
 * therefore what widening the window would actually buy — extend it by its own
 * width again, and if the extreme moves by more than a twentieth of the P&L
 * already on screen, the edge was hiding something.
 */
export function curveExtremes(prices: number[], pnl: number[]): CurveExtremes {
  if (pnl.length < 2) {
    return { maxProfit: 0, maxLoss: 0, profitUncapped: false, lossUncapped: false };
  }
  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  for (const v of pnl) {
    if (v > maxProfit) maxProfit = v;
    if (v < maxLoss) maxLoss = v;
  }

  const n = pnl.length;
  const width = prices[n - 1] - prices[0];
  const span = Math.max(maxProfit - maxLoss, 1);
  // What another window's width of price movement would add at each edge.
  const outR = ((pnl[n - 1] - pnl[n - 2]) / (prices[n - 1] - prices[n - 2])) * width;
  const outL = -((pnl[1] - pnl[0]) / (prices[1] - prices[0])) * width;
  const material = (x: number) => x / span > 0.05;

  return {
    maxProfit,
    maxLoss,
    profitUncapped: material(outR) || material(outL),
    lossUncapped: material(-outR) || material(-outL),
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
