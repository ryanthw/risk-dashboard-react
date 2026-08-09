/**
 * Statistics over the daily snapshot series.
 *
 * IMPORTANT: until deposits and withdrawals are tracked, `net_liquidity` mixes
 * trading P&L with contributions. Every figure here that compares two points in
 * time (change, drawdown) therefore describes the *balance*, not the *return* —
 * a deposit registers as a gain and resets the high-water mark. Callers must
 * label these as balance figures. Real time-weighted return needs the cash-flow
 * ledger; see `curveStats().flowAdjusted`.
 */
import type { Snapshot } from "@/types";

const MS_PER_DAY = 86_400_000;

export interface CurveStats {
  first: number;
  latest: number;
  /** Change vs the previous snapshot, or null when there is only one. */
  changeVsPrior: number | null;
  changeVsFirst: number;
  /** Highest net liquidity observed, and when. */
  highWaterMark: number;
  daysSinceHigh: number | null;
  /** Deepest peak-to-trough decline, as a positive %. */
  maxDrawdown: number;
  /** Current decline from the running peak, as a positive %. */
  currentDrawdown: number;
  count: number;
  /** Calendar days spanned by the series. */
  spanDays: number;
  /** Median gap between snapshots — how irregular the sampling actually is. */
  medianGapDays: number | null;
  /** False until cash flows are tracked; a guard against reading these as returns. */
  flowAdjusted: false;
}

export function curveStats(snapshots: Snapshot[]): CurveStats | null {
  const points = snapshots
    .filter((s) => s.net_liquidity != null && Number.isFinite(s.net_liquidity))
    .map((s) => ({ ts: new Date(s.ts).getTime(), v: s.net_liquidity as number }))
    .sort((a, b) => a.ts - b.ts);
  if (points.length === 0) return null;

  const first = points[0].v;
  const last = points[points.length - 1];

  let peak = points[0].v;
  let maxDd = 0;
  let hwmTs = points[0].ts;
  for (const p of points) {
    if (p.v > peak) {
      peak = p.v;
      hwmTs = p.ts;
    }
    if (peak > 0) {
      const dd = ((peak - p.v) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  // The running peak at the end of the walk is the high-water mark.
  const hwm = peak;

  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    gaps.push((points[i].ts - points[i - 1].ts) / MS_PER_DAY);
  }
  gaps.sort((a, b) => a - b);
  const medianGapDays = gaps.length
    ? gaps.length % 2
      ? gaps[(gaps.length - 1) / 2]
      : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2
    : null;

  return {
    first,
    latest: last.v,
    changeVsPrior: points.length > 1 ? last.v - points[points.length - 2].v : null,
    changeVsFirst: last.v - first,
    highWaterMark: hwm,
    daysSinceHigh: Math.round((last.ts - hwmTs) / MS_PER_DAY),
    maxDrawdown: maxDd,
    currentDrawdown: hwm > 0 ? ((hwm - last.v) / hwm) * 100 : 0,
    count: points.length,
    spanDays: Math.round((last.ts - points[0].ts) / MS_PER_DAY),
    medianGapDays,
    flowAdjusted: false,
  };
}

/**
 * Where the newest value sits within the historical distribution of a snapshot
 * field, as a percentile 0-100. Answers "is today rich or poor versus my own
 * history" without needing any return calculation.
 */
export function selfPercentile(
  snapshots: Snapshot[],
  field: "erpa" | "weighted_delta" | "expected_profit_total",
): { value: number; percentile: number; n: number } | null {
  const vals = snapshots
    .map((s) => s[field])
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (vals.length < 2) return null;
  const current = vals[vals.length - 1];
  const below = vals.filter((v) => v < current).length;
  return {
    value: current,
    percentile: (below / (vals.length - 1)) * 100,
    n: vals.length,
  };
}
