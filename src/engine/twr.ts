/**
 * Time-weighted return from the snapshot series and the cash ledger.
 *
 * TWR is the number that answers "how well did I trade", because it strips out
 * the timing and size of deposits — money you added is not money you made.
 * (Money-weighted/IRR answers a different question: how well the account did
 * given when you funded it. Both are worth having; this module is the first.)
 *
 * True TWR revalues the portfolio at every cash-flow date. Snapshots only exist
 * when a refresh was run, so instead each snapshot-to-snapshot interval is
 * measured with Modified Dietz, which day-weights the flows inside it by how
 * long they were actually invested. The sub-period returns are then chained.
 * With flows that fall on snapshot days this reduces to exact TWR; the
 * approximation only bites when a flow lands mid-gap.
 */
import type { CashFlowKind, Snapshot } from "@/types";
import { isExternal } from "./cashFlow";

const MS_PER_DAY = 86_400_000;

export interface LedgerEntry {
  ts: string;
  amount: number;
  kind: CashFlowKind;
}

export interface TwrPeriod {
  start: number;
  end: number;
  beginValue: number;
  endValue: number;
  /** Net external flow inside the period. */
  flow: number;
  /** Sub-period return as a fraction. */
  ret: number;
}

export interface TwrResult {
  /** Cumulative time-weighted return as a fraction (0.12 = +12%). */
  totalReturn: number;
  /** Annualized from the observed span. null when the span is too short to mean anything. */
  annualized: number | null;
  /** Deepest peak-to-trough decline of the flow-adjusted index, as a positive %. */
  maxDrawdown: number;
  /** Decline from the index's running peak, as a positive %. */
  currentDrawdown: number;
  /** Net external contributions over the window. */
  netContributions: number;
  /** Balance change that was trading rather than funding. */
  tradingPnl: number;
  periods: TwrPeriod[];
  spanDays: number;
  /** Growth index starting at 1, aligned with `periods` boundaries. */
  index: { ts: number; value: number }[];
}

/** Annualizing a handful of days turns noise into a headline number. */
const MIN_SPAN_DAYS_TO_ANNUALIZE = 60;

export function computeTwr(
  snapshots: Snapshot[],
  ledger: LedgerEntry[],
): TwrResult | null {
  const points = snapshots
    .filter((s) => s.net_liquidity != null && Number.isFinite(s.net_liquidity))
    .map((s) => ({ ts: new Date(s.ts).getTime(), v: s.net_liquidity as number }))
    .sort((a, b) => a.ts - b.ts);
  if (points.length < 2) return null;

  const flows = ledger
    .filter((e) => isExternal(e.kind))
    .map((e) => ({ ts: new Date(e.ts).getTime(), amount: Number(e.amount) }))
    .filter((e) => Number.isFinite(e.ts) && Number.isFinite(e.amount))
    .sort((a, b) => a.ts - b.ts);

  const periods: TwrPeriod[] = [];
  let cumulative = 1;
  const index: { ts: number; value: number }[] = [{ ts: points[0].ts, value: 1 }];
  let netContributions = 0;

  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1].ts;
    const end = points[i].ts;
    const beginValue = points[i - 1].v;
    const endValue = points[i].v;
    const spanMs = end - start;

    // Flows land in (start, end]: a flow exactly on a snapshot is already
    // reflected in that snapshot's value, so it belongs to the prior period.
    const inPeriod = flows.filter((f) => f.ts > start && f.ts <= end);
    const flow = inPeriod.reduce((a, f) => a + f.amount, 0);
    netContributions += flow;

    // Modified Dietz: weight each flow by the fraction of the period it was
    // invested for. A deposit on the last day barely had a chance to earn.
    let weighted = 0;
    for (const f of inPeriod) {
      const w = spanMs > 0 ? (end - f.ts) / spanMs : 0;
      weighted += f.amount * w;
    }

    const denominator = beginValue + weighted;
    // A non-positive base makes the ratio meaningless (and can flip its sign),
    // so the period is skipped rather than fabricating a return for it.
    const ret = denominator > 0 ? (endValue - beginValue - flow) / denominator : 0;

    cumulative *= 1 + ret;
    periods.push({ start, end, beginValue, endValue, flow, ret });
    index.push({ ts: end, value: cumulative });
  }

  let peak = index[0].value;
  let maxDrawdown = 0;
  for (const p of index) {
    if (p.value > peak) peak = p.value;
    if (peak > 0) {
      const dd = ((peak - p.value) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const spanDays = (points[points.length - 1].ts - points[0].ts) / MS_PER_DAY;
  const totalReturn = cumulative - 1;

  return {
    totalReturn,
    annualized:
      spanDays >= MIN_SPAN_DAYS_TO_ANNUALIZE && spanDays > 0
        ? (1 + totalReturn) ** (365 / spanDays) - 1
        : null,
    maxDrawdown,
    currentDrawdown: peak > 0 ? ((peak - cumulative) / peak) * 100 : 0,
    netContributions,
    // What the balance did, less what you put in — the dollar counterpart to TWR.
    tradingPnl: points[points.length - 1].v - points[0].v - netContributions,
    periods,
    spanDays: Math.round(spanDays),
    index,
  };
}
