/**
 * Suggested actions for the open book: what is worth doing something about
 * today, as opposed to what is merely worth knowing (that is insights.ts).
 *
 * Each rule reads only the live positions and, where it helps, this
 * portfolio's own track record. Marks are model marks — Black-Scholes on the
 * position's live IV mark and the latest underlying quote — not broker quotes,
 * and every action that leans on one says so. A position whose IV mark has
 * stopped updating is still reported, with that caveat attached, because a
 * stale mark is no reason to miss an expiry.
 *
 * One action per position at most, taken from the most urgent rule that
 * matches: a short put that is in the money and expiring Friday is one thing
 * to do, not two cards about the same contract.
 */
import {
  CREDIT_TYPES,
  TRADE_TYPE_LABELS,
  isSpread,
  type BookStat,
  type TradeType,
} from "@/types";
import { fmtUsd } from "@/lib/format";
import { theoreticalValue } from "./blackScholes";
import { MIN_N_FOR_RATE } from "./insights";
import type { Position } from "./portfolio";
import { assignmentRisks, largestTickerRisk, shortStrike } from "./portfolioRisk";
import { isCreditSpread } from "./spread";

/** Option positions expiring inside this window need a decision. Matches the Dashboard. */
export const EXPIRY_WINDOW_DAYS = 7;
/** Long options inside this window lose value fastest; flagged while out of the money. */
export const DECAY_WINDOW_DAYS = 21;
/** Profit-taking point for short premium when the book has no history of its own. */
export const DEFAULT_TAKE_PROFIT = 0.5;
/** A short strike this close (% of strike), still out of the money, is worth watching. */
export const NEAR_STRIKE_PCT = 5;
/** One ticker carrying this share of net liquidity in defined risk is concentrated. */
export const CONCENTRATION_PCT = 25;

export type ActionPriority = "high" | "medium" | "low";

export interface Action {
  id: string;
  priority: ActionPriority;
  /** Null for book-level actions. */
  ticker: string | null;
  title: string;
  detail: string;
}

export interface Mark {
  /** Per share: the entry premium or cost basis. */
  entry: number;
  /** Per share: model value now. */
  mark: number;
  /** Position P&L at the mark, in dollars. */
  pnl: number;
  /**
   * P&L as a fraction of entry. For short premium this is also the share of
   * max profit captured, since the credit is the best case.
   */
  pnlPct: number | null;
  /** True when the IV behind the mark has stopped updating. */
  stale: boolean;
}

const label = (t: TradeType) => TRADE_TYPE_LABELS[t] ?? t;
const isCredit = (t: TradeType) => CREDIT_TYPES.includes(t);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const px = (x: number) => `$${x.toFixed(2)}`;
const days = (d: number) => `${Math.max(Math.floor(d), 0)}d`;

/**
 * Model mark for a position, or null when there is nothing to price it from
 * (no underlying quote, or no entry to compare against).
 */
export function modelMark({ trade, metrics }: Position): Mark | null {
  const S = trade.underlying_price;
  if (S == null || S <= 0) return null;
  if (trade.trade_type === "shares") {
    if (trade.cost_basis == null) return null;
    return {
      entry: trade.cost_basis,
      mark: S,
      pnl: (S - trade.cost_basis) * trade.qty,
      pnlPct: trade.cost_basis > 0 ? S / trade.cost_basis - 1 : null,
      stale: false,
    };
  }
  if (trade.premium == null) return null;
  const mult = 100 * trade.qty;
  const value = theoreticalValue(trade, S, metrics.dte / 365, trade.iv);
  const entry = Math.abs(trade.premium);
  const credit = isCredit(trade.trade_type);
  // theoreticalValue is signed from the holder's side: negative for what is
  // owed on a short. Per share, positive either way.
  const mark = Math.abs(value) / mult;
  const pnl = (credit ? entry - mark : mark - entry) * mult;
  return {
    entry,
    mark,
    pnl,
    pnlPct: entry > 0 ? (credit ? entry - mark : mark - entry) / entry : null,
    stale: trade.iv_source === "last_good",
  };
}

const STALE_NOTE = " The IV behind this mark has stopped updating, so treat the mark as approximate.";

/**
 * Where to take profit on a structure: the point this book has actually been
 * closing it at, when enough closed trades record it, else the standard 50%.
 */
function profitTarget(type: TradeType, stats: BookStat[]): { target: number; why: string } {
  const s = stats.find((x) => x.grain === "strategy" && x.trade_type === type);
  const kept = s?.mean_return_on_premium;
  if (s && kept != null && kept > 0 && kept < 1 && s.n_return_on_premium >= MIN_N_FOR_RATE) {
    return {
      target: kept,
      why: `your ${label(type)}s have kept ${pct(kept)} of premium on average at close (${s.n_return_on_premium} trades)`,
    };
  }
  return { target: DEFAULT_TAKE_PROFIT, why: `the standard ${pct(DEFAULT_TAKE_PROFIT)} take-profit point` };
}

/**
 * Covered calls with nothing covering them, per ticker. Cover is 100 shares or
 * one long call per contract, and a long call only covers a short call that
 * expires no later than it does — a LEAPS that lapses first leaves the short
 * call naked for the remainder.
 */
function uncoveredCalls(positions: Position[]): Map<string, number> {
  const out = new Map<string, number>();
  const tickers = new Set(positions.filter((p) => p.trade.trade_type === "cc").map((p) => p.trade.ticker));
  for (const tk of tickers) {
    const mine = positions.filter((p) => p.trade.ticker === tk);
    const expiry = (e: string | null) => (e ? new Date(e).getTime() : Infinity);
    const shorts = mine
      .filter((p) => p.trade.trade_type === "cc")
      .flatMap((p) => Array<number>(p.trade.qty).fill(expiry(p.trade.expiration)));
    const covers = [
      ...Array<number>(
        Math.floor(mine.filter((p) => p.trade.trade_type === "shares").reduce((n, p) => n + p.trade.qty, 0) / 100),
      ).fill(Infinity),
      ...mine
        .filter((p) => p.trade.trade_type === "long_call")
        .flatMap((p) => Array<number>(p.trade.qty).fill(expiry(p.trade.expiration))),
    ].sort((a, b) => b - a);
    // Latest-dated short first, each taking the longest-dated cover left: if
    // that cannot cover it, nothing remaining can.
    let uncovered = 0;
    for (const exp of shorts.sort((a, b) => b - a)) {
      if (covers.length && covers[0] >= exp) covers.shift();
      else uncovered++;
    }
    if (uncovered > 0) out.set(tk, uncovered);
  }
  return out;
}

export function suggestActions(
  positions: Position[],
  stats: BookStat[],
  netLiq: number,
): Action[] {
  const out: Action[] = [];
  const handled = new Set<string>();
  const take = (id: string, a: Omit<Action, "id">) => {
    handled.add(id);
    out.push({ id, ...a });
  };

  // ---- unbounded or uncovered short calls -----------------------------------
  for (const p of positions) {
    if (p.trade.trade_type !== "short_call") continue;
    take(p.trade.id, {
      priority: "high",
      ticker: p.trade.ticker,
      title: `${p.trade.ticker} naked call ${px(p.trade.strike ?? 0)} — unbounded risk`,
      detail: `${p.trade.qty} contract${p.trade.qty === 1 ? "" : "s"}, ${days(p.metrics.dte)} to expiry. A naked call has no maximum loss; buying shares or a longer-dated call caps it.`,
    });
  }
  for (const [tk, n] of uncoveredCalls(positions)) {
    out.push({
      id: `uncovered-${tk}`,
      priority: "high",
      ticker: tk,
      title: `${tk}: ${n} covered call${n === 1 ? "" : "s"} without cover`,
      detail:
        "More short calls than covering shares (per 100) or long calls that outlast them. " +
        "The excess is a naked call in practice: add cover or buy back the excess.",
    });
  }

  // ---- short legs in the money -----------------------------------------------
  for (const a of assignmentRisks(positions)) {
    const { trade, metrics } = a.position;
    if (handled.has(trade.id)) continue;
    if (a.atMaxProfit) {
      take(trade.id, {
        priority: "medium",
        ticker: trade.ticker,
        title: `${trade.ticker} ${label(trade.trade_type)} at max profit`,
        detail:
          `Short ${a.kind} ${px(a.strike)} is ${a.itmPct.toFixed(1)}% in the money with ${days(metrics.dte)} left. ` +
          "Closing locks in the gain; holding risks early assignment on the short leg while the long leg is still open.",
      });
      continue;
    }
    const called = trade.trade_type === "cc";
    take(trade.id, {
      priority: metrics.dte <= EXPIRY_WINDOW_DAYS ? "high" : "medium",
      ticker: trade.ticker,
      title: `${trade.ticker} ${label(trade.trade_type)} ${px(a.strike)} ${a.kind} is ${a.itmPct.toFixed(1)}% in the money`,
      detail:
        `${days(metrics.dte)} to expiry, underlying ${px(trade.underlying_price ?? 0)}. ` +
        (called
          ? "Roll up and out to keep the cover, or accept being called away."
          : "Roll out (and down/up) for a credit, close, or prepare for assignment."),
    });
  }

  // ---- expiring this week ------------------------------------------------------
  for (const p of positions) {
    const { trade, metrics } = p;
    if (handled.has(trade.id) || trade.trade_type === "shares") continue;
    if (!trade.expiration || metrics.dte > EXPIRY_WINDOW_DAYS) continue;
    const m = modelMark(p);
    const credit = isCredit(trade.trade_type);
    const where =
      m == null
        ? ""
        : credit
          ? ` Model mark ${px(m.mark)} against ${px(m.entry)} collected (${pct(m.pnlPct ?? 0)} captured).`
          : ` Model value ${px(m.mark)} against ${px(m.entry)} paid.`;
    take(trade.id, {
      priority: credit ? "low" : "medium",
      ticker: trade.ticker,
      title: `${trade.ticker} ${label(trade.trade_type)} expires in ${days(metrics.dte)}`,
      detail:
        (credit
          ? "Out of the money: let it expire, or close it for what is left to free the collateral."
          : "Sell what value remains or let it lapse — after expiry it is worth nothing.") +
        where +
        (m?.stale ? STALE_NOTE : ""),
    });
  }

  // ---- short premium at its profit target ---------------------------------------
  for (const p of positions) {
    const { trade, metrics } = p;
    if (handled.has(trade.id) || !isCredit(trade.trade_type)) continue;
    const m = modelMark(p);
    if (m?.pnlPct == null) continue;
    const { target, why } = profitTarget(trade.trade_type, stats);
    if (m.pnlPct < target) continue;
    take(trade.id, {
      priority: "medium",
      ticker: trade.ticker,
      title: `${trade.ticker} ${label(trade.trade_type)}: ${pct(m.pnlPct)} of max profit captured`,
      detail:
        `Model mark ${px(m.mark)} against ${px(m.entry)} collected, ${fmtUsd(m.pnl)} on the position with ${days(metrics.dte)} left. ` +
        `At or past ${pct(target)} — ${why}. Closing now frees the collateral for the next trade.` +
        (m.stale ? STALE_NOTE : ""),
    });
  }

  // ---- long options losing time value fastest ------------------------------------
  for (const p of positions) {
    const { trade, metrics } = p;
    if (handled.has(trade.id)) continue;
    if (trade.trade_type !== "long_call" && trade.trade_type !== "long_put") continue;
    if (metrics.dte > DECAY_WINDOW_DAYS) continue;
    const S = trade.underlying_price ?? 0;
    const K = trade.strike ?? 0;
    const otm = trade.trade_type === "long_call" ? S < K : S > K;
    if (!otm || S <= 0) continue;
    const m = modelMark(p);
    take(trade.id, {
      priority: "medium",
      ticker: trade.ticker,
      title: `${trade.ticker} ${label(trade.trade_type)} ${px(K)}: out of the money with ${days(metrics.dte)} left`,
      detail:
        `Time decay is steepest inside ${DECAY_WINDOW_DAYS} days` +
        (m ? `; model value ${px(m.mark)} against ${px(m.entry)} paid` : "") +
        `, losing about ${fmtUsd(Math.abs(metrics.greeks.theta))} a day. Sell or roll out unless you expect the move soon.` +
        (m?.stale ? STALE_NOTE : ""),
    });
  }

  // ---- short strikes close to the money ------------------------------------------
  for (const p of positions) {
    const { trade, metrics } = p;
    if (handled.has(trade.id)) continue;
    const short = shortStrike(trade);
    const S = trade.underlying_price ?? 0;
    if (!short || short.strike <= 0 || S <= 0) continue;
    // Debit spreads want their short leg reached; only credit risk is "near".
    if (isSpread(trade.trade_type) && !isCreditSpread(trade.trade_type)) continue;
    const gap = ((short.kind === "put" ? S - short.strike : short.strike - S) / short.strike) * 100;
    if (gap < 0 || gap > NEAR_STRIKE_PCT) continue;
    take(trade.id, {
      priority: "low",
      ticker: trade.ticker,
      title: `${trade.ticker} ${label(trade.trade_type)} is ${gap.toFixed(1)}% from its short strike`,
      detail: `Underlying ${px(S)} against the ${px(short.strike)} ${short.kind}, ${days(metrics.dte)} to expiry. No action yet; a close or roll is cheaper before it goes in the money than after.`,
    });
  }

  // ---- concentration ---------------------------------------------------------------
  const largest = largestTickerRisk(positions, netLiq);
  if (largest && netLiq > 0 && largest.pctOfValue >= CONCENTRATION_PCT) {
    const n = positions.filter((p) => p.trade.ticker === largest.ticker).length;
    out.push({
      id: `concentration-${largest.ticker}`,
      priority: "medium",
      ticker: largest.ticker,
      title: `${largest.ticker} carries ${Math.round(largest.pctOfValue)}% of net liquidity at risk`,
      detail:
        `${fmtUsd(largest.maxLoss)} of defined max loss across ${n} position${n === 1 ? "" : "s"}. ` +
        `Above ${CONCENTRATION_PCT}%, one name's move decides the month — trim or hedge before adding to it.`,
    });
  }

  const rank: Record<ActionPriority, number> = { high: 0, medium: 1, low: 2 };
  return out.sort(
    (a, b) => rank[a.priority] - rank[b.priority] || (a.ticker ?? "").localeCompare(b.ticker ?? ""),
  );
}
