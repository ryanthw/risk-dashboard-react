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
import type { Position } from "./portfolio";

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
// Exposure, concentration, leverage
// ---------------------------------------------------------------------------

export interface TickerExposure {
  ticker: string;
  /** Share-equivalent delta: $ P&L per $1 move in the underlying. */
  shareDelta: number;
  /** shareDelta x spot — the dollar of underlying the book is actually long. */
  exposure: number;
  /** Signed exposure as a % of net liquidity. */
  pctOfNav: number;
  beta: number;
  /** exposure x beta — exposure restated in index-equivalent dollars. */
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
  const byTicker = new Map<string, { delta: number; beta: number; legs: number }>();

  for (const { trade, metrics } of positions) {
    const spot = trade.underlying_price ?? 0;
    if (spot <= 0) continue;
    const delta = metrics.greeks.delta;
    if (!Number.isFinite(delta)) continue;

    const prev = byTicker.get(trade.ticker);
    if (prev) {
      prev.delta += delta;
      prev.legs += 1;
    } else {
      byTicker.set(trade.ticker, { delta, beta: trade.beta ?? 1, legs: 1 });
    }
  }

  const spots = new Map<string, number>();
  for (const { trade } of positions) {
    const spot = trade.underlying_price ?? 0;
    if (spot > 0) spots.set(trade.ticker, spot);
  }

  const out: TickerExposure[] = [];
  for (const [ticker, agg] of byTicker) {
    const spot = spots.get(ticker) ?? 0;
    const exposure = agg.delta * spot;
    out.push({
      ticker,
      shareDelta: agg.delta,
      exposure,
      pctOfNav: netLiq > 0 ? (exposure / netLiq) * 100 : 0,
      beta: agg.beta,
      betaWeighted: exposure * agg.beta,
      legs: agg.legs,
    });
  }
  return out.sort((a, b) => Math.abs(b.exposure) - Math.abs(a.exposure));
}

export interface Leverage {
  /** Sum of |exposure| across underlyings. */
  grossExposure: number;
  /** Signed sum — what a broad market move actually moves. */
  netExposure: number;
  /** grossExposure / net liquidity. 1.0x means fully invested, no leverage. */
  gross: number;
  net: number;
  /** Net exposure restated in index-equivalent dollars, over net liquidity. */
  betaWeighted: number;
  betaWeightedExposure: number;
}

export function leverage(exposures: TickerExposure[], netLiq: number): Leverage {
  const grossExposure = exposures.reduce((a, e) => a + Math.abs(e.exposure), 0);
  const netExposure = exposures.reduce((a, e) => a + e.exposure, 0);
  const betaWeightedExposure = exposures.reduce((a, e) => a + e.betaWeighted, 0);
  const safe = netLiq > 0 ? netLiq : NaN;
  return {
    grossExposure,
    netExposure,
    betaWeightedExposure,
    gross: grossExposure / safe,
    net: netExposure / safe,
    betaWeighted: betaWeightedExposure / safe,
  };
}

export interface Concentration {
  /**
   * Herfindahl-Hirschman index over each underlying's share of gross exposure,
   * on 0-1. One position is 1.0; ten equal positions is 0.1.
   */
  hhi: number;
  /**
   * 1 / HHI — how many equally-sized positions the book is *effectively*
   * spread across. Far more legible than the index itself: a book of eight
   * names where two carry 70% has an effective count near 3, and that number
   * says something a raw 0.34 does not.
   */
  effectiveNames: number;
  /** Distinct underlyings actually carrying exposure. */
  names: number;
  topTicker: string | null;
  /** The largest single name's share of gross exposure, as a %. */
  topPct: number;
}

const EMPTY_CONCENTRATION: Concentration = {
  hhi: 0,
  effectiveNames: 0,
  names: 0,
  topTicker: null,
  topPct: 0,
};

/**
 * Concentration over *gross* exposure shares.
 *
 * Gross rather than net because concentration is a question about how much of
 * the book rides on one name being right, and a long LEAP hedged by a short
 * call is still all one bet. Netting first would report a hedged, concentrated
 * book as diversified.
 */
export function concentration(exposures: TickerExposure[]): Concentration {
  const gross = exposures.reduce((a, e) => a + Math.abs(e.exposure), 0);
  if (gross <= 0) return EMPTY_CONCENTRATION;

  let hhi = 0;
  let top: TickerExposure | null = null;
  for (const e of exposures) {
    const share = Math.abs(e.exposure) / gross;
    hhi += share * share;
    if (!top || Math.abs(e.exposure) > Math.abs(top.exposure)) top = e;
  }

  return {
    hhi,
    effectiveNames: hhi > 0 ? 1 / hhi : 0,
    names: exposures.filter((e) => Math.abs(e.exposure) > 0).length,
    topTicker: top?.ticker ?? null,
    topPct: top ? (Math.abs(top.exposure) / gross) * 100 : 0,
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
