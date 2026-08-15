/**
 * Metrics that exist for the Reports page: period windowing, exposure
 * concentration, and leverage.
 *
 * Everything performance-related (TWR, Sharpe, drawdown, track record) already
 * lives in twr.ts and trackRecord.ts and is reused as-is — a report that
 * recomputed its own version of those would be free to disagree with the rest
 * of the app, which is the one thing a statement must never do.
 */
import type { HistoryTrade, Snapshot } from "@/types";
import { hhi, type Position } from "./portfolio";
import { largestTickerRisk } from "./portfolioRisk";

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Reporting period
// ---------------------------------------------------------------------------

export const PERIOD_KEYS = ["1M", "3M", "YTD", "ALL"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  "1M": "1 Month",
  "3M": "Quarter",
  YTD: "Year to Date",
  ALL: "All Time",
};

/**
 * Inclusive lower bound for a period, or null for ALL.
 *
 * Month arithmetic goes through setMonth so a 3M window from the 31st lands on
 * a real date — Date normalizes 31 Feb forward, which is the conventional
 * behaviour for "three months ago" and keeps the window from silently
 * swallowing an extra few days.
 */
export function periodStart(key: PeriodKey, now = new Date()): Date | null {
  switch (key) {
    case "1M": {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 1);
      return d;
    }
    case "3M": {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 3);
      return d;
    }
    case "YTD":
      return new Date(now.getFullYear(), 0, 1);
    case "ALL":
      return null;
  }
}

export interface Period {
  key: PeriodKey;
  label: string;
  /** null when the period is ALL — the series supplies its own start. */
  start: Date | null;
  end: Date;
}

export function resolvePeriod(key: PeriodKey, now = new Date()): Period {
  return { key, label: PERIOD_LABELS[key], start: periodStart(key, now), end: now };
}

/**
 * Snapshots inside the window, plus the last one *before* it.
 *
 * The leading snapshot is the period's opening valuation. Without it a
 * three-month TWR would start from the first observation inside the window and
 * silently discard whatever happened between the period boundary and that
 * observation — on a sparse series that can be a week of return.
 */
export function snapshotsInPeriod(snapshots: Snapshot[], period: Period): Snapshot[] {
  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
  );
  if (!period.start) return sorted;
  const startMs = period.start.getTime();

  const inside = sorted.filter((s) => new Date(s.ts).getTime() >= startMs);
  const before = sorted.filter((s) => new Date(s.ts).getTime() < startMs);
  const opening = before.length ? [before[before.length - 1]] : [];
  return [...opening, ...inside];
}

/** Trades whose exit falls inside the window. Undated exits are excluded. */
export function tradesInPeriod(trades: HistoryTrade[], period: Period): HistoryTrade[] {
  if (!period.start) return trades.filter((t) => t.exit_date != null);
  const startMs = period.start.getTime();
  const endMs = period.end.getTime();
  return trades.filter((t) => {
    if (!t.exit_date) return false;
    const ms = new Date(t.exit_date).getTime();
    return Number.isFinite(ms) && ms >= startMs && ms <= endMs;
  });
}

// ---------------------------------------------------------------------------
// Exposure and concentration
//
// Two different questions, deliberately kept apart:
//
//   Capital at risk — how much money can actually be lost. In a cash account
//   this is the binding constraint and cannot exceed the account, so the ratio
//   to portfolio value is bounded at 1.0x. It is what `leverageRatio` in
//   portfolio.ts measures, and it is the primary number.
//
//   Notional exposure — how much underlying the book moves with, from delta.
//   A deep ITM long call costing $930 carries $2,200 of it. That is real and
//   worth reporting, but it is NOT leverage: no money is borrowed and nothing
//   beyond the premium can be lost. Reporting it as leverage overstates the
//   risk of a strategy whose entire point is bounded downside.
// ---------------------------------------------------------------------------

export interface TickerExposure {
  ticker: string;
  /** Share-equivalent delta: $ P&L per $1 move in the underlying. */
  shareDelta: number;
  /** shareDelta x spot — how much underlying the book moves with. */
  notional: number;
  /** Signed notional as a % of net liquidity. */
  pctOfNav: number;
  /** Sum of each leg's max loss — the money genuinely at stake on this name. */
  capitalAtRisk: number;
  /** True when a leg on this ticker has unbounded loss (a naked short call). */
  undefinedRisk: boolean;
  beta: number;
  /** notional x beta — restated in index-equivalent dollars. */
  betaWeighted: number;
  legs: number;
}

/**
 * Net dollar exposure per underlying, from real Black-Scholes deltas.
 *
 * Legs on the same ticker net against each other before anything is squared or
 * summed, which is the whole point: a covered call written against a LEAP is
 * one position with one exposure, and counting the two legs separately would
 * report a concentration the book does not have.
 */
export function exposureByTicker(positions: Position[], netLiq: number): TickerExposure[] {
  const byTicker = new Map<
    string,
    {
      delta: number;
      beta: number;
      legs: number;
      spot: number;
      risk: number;
      undefinedRisk: boolean;
    }
  >();

  for (const { trade, metrics } of positions) {
    const spot = trade.underlying_price ?? 0;
    if (spot <= 0) continue;
    const delta = metrics.greeks.delta;
    if (!Number.isFinite(delta)) continue;

    // A naked short call's max loss is Infinity. Summing it would make the
    // whole ticker Infinity, so it is tracked as a flag and the finite legs
    // still add up — the flag is what tells the reader the total is a floor.
    const bounded = Number.isFinite(metrics.maxLoss);

    const prev = byTicker.get(trade.ticker);
    if (prev) {
      prev.delta += delta;
      prev.legs += 1;
      if (bounded) prev.risk += Math.abs(metrics.maxLoss);
      else prev.undefinedRisk = true;
    } else {
      byTicker.set(trade.ticker, {
        delta,
        beta: trade.beta ?? 1,
        legs: 1,
        spot,
        risk: bounded ? Math.abs(metrics.maxLoss) : 0,
        undefinedRisk: !bounded,
      });
    }
  }

  const out: TickerExposure[] = [];
  for (const [ticker, agg] of byTicker) {
    const notional = agg.delta * agg.spot;
    out.push({
      ticker,
      shareDelta: agg.delta,
      notional,
      pctOfNav: netLiq > 0 ? (notional / netLiq) * 100 : 0,
      capitalAtRisk: agg.risk,
      undefinedRisk: agg.undefinedRisk,
      beta: agg.beta,
      betaWeighted: notional * agg.beta,
      legs: agg.legs,
    });
  }
  // Ranked by money at stake, not by notional — that is the order the reader
  // needs when deciding what to trim.
  return out.sort((a, b) => b.capitalAtRisk - a.capitalAtRisk);
}

export interface NotionalExposure {
  /** Sum of |notional| across underlyings. */
  gross: number;
  /** Signed sum — what a broad move in every name actually moves. */
  net: number;
  /** Net notional restated in index-equivalent dollars. */
  betaWeighted: number;
  /** Each of the above over net liquidity, as a multiple. */
  grossOfNav: number;
  netOfNav: number;
  betaWeightedOfNav: number;
}

/**
 * Delta notional for the book. Explicitly not named leverage — see the note at
 * the top of this section.
 */
export function notionalExposure(
  exposures: TickerExposure[],
  netLiq: number,
): NotionalExposure {
  const gross = exposures.reduce((a, e) => a + Math.abs(e.notional), 0);
  const net = exposures.reduce((a, e) => a + e.notional, 0);
  const betaWeighted = exposures.reduce((a, e) => a + e.betaWeighted, 0);
  const safe = netLiq > 0 ? netLiq : NaN;
  return {
    gross,
    net,
    betaWeighted,
    grossOfNav: gross / safe,
    netOfNav: net / safe,
    betaWeightedOfNav: betaWeighted / safe,
  };
}

export interface Concentration {
  /**
   * Herfindahl-Hirschman index over each underlying's share of capital at
   * risk, on 0-1. One position is 1.0; ten equal positions is 0.1.
   */
  hhi: number;
  /**
   * 1 / HHI — how many equally-sized positions the book is *effectively*
   * spread across. Far more legible than the index itself: a book of seven
   * names where one carries 30% has an effective count of 5, and that number
   * says something a raw 0.20 does not.
   */
  effectiveNames: number;
  /** Distinct underlyings carrying capital at risk. */
  names: number;
  topTicker: string | null;
  /** The largest single name's share of capital at risk, as a %. */
  topPct: number;
}

/**
 * Concentration, measured over capital at risk.
 *
 * The index itself comes from portfolio.ts rather than being recomputed here,
 * so the report and the Dashboard cannot drift apart on what HHI means. This
 * adds only the two figures the Dashboard doesn't surface: the reciprocal and
 * the leader's share.
 *
 * Capital at risk rather than delta notional, deliberately. Concentration is a
 * question about how much of the account one name can take down, and what a
 * name can take down is the money staked on it — a $930 call carrying $2,200
 * of notional can still only lose $930.
 */
export function concentration(
  positions: Position[],
  portValue: number,
): Concentration {
  const index = hhi(positions);
  const top = largestTickerRisk(positions, portValue);

  const names = new Set(
    positions
      .filter((p) => Number.isFinite(p.metrics.maxLoss) && p.metrics.maxLoss > 0)
      .map((p) => p.trade.ticker),
  ).size;

  const grossRisk = positions.reduce(
    (a, p) => (Number.isFinite(p.metrics.maxLoss) ? a + Math.abs(p.metrics.maxLoss) : a),
    0,
  );

  return {
    hhi: index,
    effectiveNames: index > 0 ? 1 / index : 0,
    names,
    topTicker: top?.ticker ?? null,
    topPct: top && grossRisk > 0 ? (top.maxLoss / grossRisk) * 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// Realized P&L over time
// ---------------------------------------------------------------------------

export interface MonthlyPnl {
  /** YYYY-MM, sortable and stable across locales. */
  month: string;
  /** "Aug 26" — for axis labels. */
  label: string;
  pnl: number;
  count: number;
}

/**
 * Realized P&L bucketed by exit month, with empty months filled in.
 *
 * The gaps matter: a bar chart that silently skips a month with no closes
 * reads as continuous activity and makes an inconsistent record look steady.
 */
export function monthlyRealized(trades: HistoryTrade[]): MonthlyPnl[] {
  const buckets = new Map<string, { pnl: number; count: number }>();
  let min: Date | null = null;
  let max: Date | null = null;

  for (const t of trades) {
    if (!t.exit_date || t.realized_pnl == null) continue;
    const d = new Date(t.exit_date);
    if (!Number.isFinite(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const prev = buckets.get(key);
    if (prev) {
      prev.pnl += t.realized_pnl;
      prev.count += 1;
    } else {
      buckets.set(key, { pnl: t.realized_pnl, count: 1 });
    }
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  }

  if (!min || !max) return [];

  const out: MonthlyPnl[] = [];
  const cursor = new Date(min.getFullYear(), min.getMonth(), 1);
  const last = new Date(max.getFullYear(), max.getMonth(), 1);
  while (cursor <= last) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    const hit = buckets.get(key);
    out.push({
      month: key,
      label: cursor.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
      pnl: hit?.pnl ?? 0,
      count: hit?.count ?? 0,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return out;
}

/** Days between entry and exit, or null when either date is missing. */
export function holdDays(trade: HistoryTrade): number | null {
  if (!trade.entry_date || !trade.exit_date) return null;
  const days =
    (new Date(trade.exit_date).getTime() - new Date(trade.entry_date).getTime()) / MS_PER_DAY;
  return Number.isFinite(days) && days >= 0 ? days : null;
}
