/**
 * The portfolio email report, as data: everything the email shows, computed
 * from the same engine the dashboard runs so the two cannot disagree.
 *
 * Pure. The script fetches rows and renders; this decides what they say. The
 * headline net liquidity is the latest logged snapshot rather than a fresh
 * recomputation — the returns are measured off the snapshot series, and a
 * headline from a different Monte-Carlo draw than the series it sits above
 * would not reconcile with it.
 */
import { buildInsights, type Insight } from "@/engine/insights";
import {
  modelMark,
  suggestActions,
  tickerRisk,
  type Action,
  type TickerRisk,
} from "@/engine/actions";
import * as P from "@/engine/portfolio";
import * as R from "@/engine/portfolioRisk";
import { deriveTradeMetrics } from "@/engine/trade";
import { computeTwr } from "@/engine/twr";
import { BENCHMARK, benchmarkReturn, closeAt, type PriceBar } from "./benchmark";
import {
  TRADE_TYPE_LABELS,
  type BookStat,
  type CashFlow,
  type HistoryTrade,
  type Portfolio,
  type Snapshot,
  type Trade,
  type TradeType,
} from "@/types";

const DAY = 86_400_000;
/** A snapshot older than this at report time is called out as stale. */
export const SNAPSHOT_STALE_HOURS = 30;
/** Research stats older than this are called out as stale. */
export const RESEARCH_STALE_DAYS = 3;
/** How far back "recently closed" reaches. */
export const CLOSED_LOOKBACK_DAYS = 7;

export interface ReportInput {
  portfolio: Portfolio;
  trades: Trade[];
  snapshots: Snapshot[];
  cashFlows: CashFlow[];
  stats: BookStat[];
  closed: HistoryTrade[];
  /** SPY daily bars; null when the fetch failed, which the report states. */
  benchmark: PriceBar[] | null;
  now: Date;
}

export interface WindowReturn {
  label: string;
  /** Time-weighted, deposits stripped. Null when history does not reach back that far. */
  ret: number | null;
  /** Balance change less contributions over the window. */
  tradingPnl: number | null;
  /** The snapshot the window is measured from. */
  from: string | null;
  /** The snapshot the window is measured to. */
  to: string | null;
  /** SPY total return over exactly the same span. */
  benchmark: number | null;
  /** ret less benchmark, in return points. */
  excess: number | null;
}

/** One point of the growth chart: both series indexed to 100 at the first snapshot. */
export interface GrowthPoint {
  ts: number;
  book: number;
  benchmark: number | null;
}


export interface TradeRow {
  ticker: string;
  structure: string;
  type: TradeType;
  strikes: string;
  expiration: string | null;
  dte: number | null;
  qty: number;
  entry: number | null;
  mark: number | null;
  pnl: number | null;
  pnlPct: number | null;
  underlying: number | null;
  /** Short strike in the money. */
  itm: boolean;
  stale: boolean;
}

export interface ReportModel {
  portfolioName: string;
  generatedAt: string;
  netLiq: number | null;
  netLiqAt: string | null;
  /** Trading P&L since the previous snapshot, deposits excluded. */
  dayChange: number | null;
  returns: WindowReturn[];
  /** Off the high of the flow-adjusted index, as a positive %. */
  drawdown: number | null;
  growth: GrowthPoint[];
  /** Defined risk by ticker, largest first. Naked calls have none to sum. */
  riskByTicker: TickerRisk[];
  book: {
    cash: number;
    buyingPower: number;
    grossExposure: number;
    thetaPerDay: number;
    betaDelta: number;
    var95: number | null;
    cvar95: number | null;
    comonotonicVar95: number | null;
    tailHorizonDays: number | null;
    openTrades: number;
    nearestDte: number | null;
    unrealizedPnl: number;
  };
  actions: Action[];
  trades: TradeRow[];
  insights: Insight[];
  closed: { ticker: string; structure: string; pnl: number | null; exitDate: string }[];
  closedTotal: number;
  notes: string[];
}

const label = (t: TradeType) => TRADE_TYPE_LABELS[t] ?? t;

/**
 * Time-weighted return over the trailing `days`, measured from the last
 * snapshot at or before the window start. When the series does not reach that
 * far back the return is null rather than quietly measured over less time.
 */
export function windowReturn(
  snapshots: Snapshot[],
  flows: CashFlow[],
  days: number | null,
  name: string,
  bars: PriceBar[] | null = null,
): WindowReturn {
  const pts = snapshots
    .filter((s) => Number.isFinite(s.net_liquidity))
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const none = {
    label: name, ret: null, tradingPnl: null, from: null, to: null, benchmark: null, excess: null,
  };
  if (pts.length < 2) return none;
  const end = pts[pts.length - 1];
  // null days: the whole series.
  let base = days == null ? 0 : -1;
  if (days != null) {
    const cutoff = new Date(end.ts).getTime() - days * DAY;
    for (let i = 0; i < pts.length; i++) if (new Date(pts[i].ts).getTime() <= cutoff) base = i;
  }
  if (base < 0) return none;
  const twr = computeTwr(pts.slice(base), flows);
  const ret = twr?.totalReturn ?? null;
  const bench = bars
    ? benchmarkReturn(bars, new Date(pts[base].ts).getTime(), new Date(end.ts).getTime())
    : null;
  return {
    label: name,
    ret,
    tradingPnl: twr?.tradingPnl ?? null,
    from: pts[base].ts,
    to: end.ts,
    benchmark: bench,
    excess: ret != null && bench != null ? ret - bench : null,
  };
}

/** Book TWR index and SPY on a common base of 100 at the first snapshot. */
function growthSeries(snapshots: Snapshot[], flows: CashFlow[], bars: PriceBar[] | null): GrowthPoint[] {
  const twr = computeTwr(snapshots, flows);
  if (!twr) return [];
  const base = bars ? closeAt(bars, twr.index[0].ts) : null;
  return twr.index.map(({ ts, value }) => {
    const px = bars && base ? closeAt(bars, ts) : null;
    return { ts, book: value * 100, benchmark: px != null && base ? (px / base) * 100 : null };
  });
}

function strikes(t: Trade): string {
  if (t.trade_type === "shares") return "";
  const k = [t.strike, t.strike_2].filter((x): x is number => x != null);
  return k.map((x) => `$${x}`).join("/");
}

export function buildReport(input: ReportInput): ReportModel {
  const { portfolio, trades, snapshots, cashFlows, stats, closed, benchmark, now } = input;
  const positions = trades.map((trade) => ({ trade, metrics: deriveTradeMetrics(trade) }));
  const cash = portfolio.cash;

  const series = [...snapshots].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const last = series[series.length - 1] ?? null;
  const prev = series[series.length - 2] ?? null;
  const day = last && prev ? computeTwr([prev, last], cashFlows) : null;
  const all = computeTwr(series, cashFlows);
  const netLiq = last?.net_liquidity ?? null;
  const denom = netLiq ?? P.netLiquidity(positions, cash);

  const tail = R.expiryTailRisk(positions);
  const marks = new Map(positions.map((p) => [p.trade.id, modelMark(p)]));
  const itm = new Set(R.assignmentRisks(positions).map((a) => a.position.trade.id));

  const rows: TradeRow[] = positions
    .map(({ trade, metrics }) => {
      const m = marks.get(trade.id) ?? null;
      return {
        ticker: trade.ticker,
        structure: label(trade.trade_type),
        type: trade.trade_type,
        strikes: strikes(trade),
        expiration: trade.expiration,
        dte: trade.expiration ? metrics.dte : null,
        qty: trade.qty,
        entry: m?.entry ?? (trade.trade_type === "shares" ? trade.cost_basis : trade.premium),
        mark: m?.mark ?? null,
        pnl: m?.pnl ?? null,
        pnlPct: m?.pnlPct ?? null,
        underlying: trade.underlying_price,
        itm: itm.has(trade.id),
        stale: m?.stale ?? false,
      };
    })
    // Dated positions by expiry, soonest first; share lots after them.
    .sort(
      (a, b) =>
        (a.dte ?? Infinity) - (b.dte ?? Infinity) ||
        a.ticker.localeCompare(b.ticker) ||
        a.structure.localeCompare(b.structure),
    );

  const since = now.getTime() - CLOSED_LOOKBACK_DAYS * DAY;
  const recent = closed
    .filter((c) => c.exit_date && new Date(c.exit_date).getTime() >= since)
    .sort((a, b) => new Date(b.exit_date!).getTime() - new Date(a.exit_date!).getTime())
    .map((c) => ({
      ticker: c.ticker,
      structure: label(c.trade_type),
      pnl: c.realized_pnl,
      exitDate: c.exit_date!,
    }));

  // ---- what the reader should know before trusting the numbers ---------------
  const notes: string[] = [];
  if (!last) {
    notes.push("No snapshots logged for this portfolio yet, so there is no net liquidity or return history.");
  } else if (now.getTime() - new Date(last.ts).getTime() > SNAPSHOT_STALE_HOURS * 3_600_000) {
    notes.push(
      `The latest snapshot is from ${last.ts.slice(0, 10)}: today's did not log, so net liquidity and returns are as of then.`,
    );
  }
  if (benchmark == null || benchmark.length === 0) {
    notes.push(`${BENCHMARK} prices could not be fetched, so this report has no market comparison.`);
  }
  const research = stats.find((s) => s.grain === "portfolio");
  if (research && now.getTime() - new Date(research.as_of).getTime() > RESEARCH_STALE_DAYS * DAY) {
    notes.push(`Track-record notes are from research as of ${research.as_of}; the daily push has not landed since.`);
  }
  const stale = rows.filter((r) => r.stale);
  if (stale.length) {
    notes.push(
      `IV mark held (no fresh chain read) for ${stale.map((r) => `${r.ticker} ${r.structure}`).join(", ")}; their model marks are approximate.`,
    );
  }
  notes.push(
    "Option marks are model values — Black-Scholes on each position's live IV mark — not broker quotes. VaR assumes uncorrelated underlyings; the perfectly correlated figure brackets it.",
  );

  return {
    portfolioName: portfolio.name,
    generatedAt: now.toISOString(),
    netLiq,
    netLiqAt: last?.ts ?? null,
    dayChange: day?.tradingPnl ?? null,
    returns: [
      windowReturn(series, cashFlows, 30, "1M", benchmark),
      windowReturn(series, cashFlows, 91, "3M", benchmark),
      windowReturn(series, cashFlows, null, "Since start", benchmark),
    ],
    drawdown: all?.currentDrawdown ?? null,
    growth: growthSeries(series, cashFlows, benchmark),
    // The concentration action's own measure, so a bar over the line and the
    // action about it cannot disagree.
    riskByTicker: tickerRisk(positions, denom),
    book: {
      cash,
      buyingPower: P.undeployedCash(positions, cash),
      grossExposure: P.grossExposure(positions),
      thetaPerDay: R.portfolioGreeks(positions).theta,
      betaDelta: P.betaWeightedDelta(positions),
      var95: tail?.var95 ?? null,
      cvar95: tail?.cvar95 ?? null,
      comonotonicVar95: tail?.comonotonicVar95 ?? null,
      tailHorizonDays: tail?.horizonDays ?? null,
      openTrades: positions.length,
      nearestDte: R.nearestDte(positions),
      unrealizedPnl: rows.reduce((s, r) => s + (r.pnl ?? 0), 0),
    },
    actions: suggestActions(positions, stats, denom),
    trades: rows,
    insights: buildInsights(stats, trades),
    closed: recent,
    closedTotal: recent.reduce((s, c) => s + (c.pnl ?? 0), 0),
    notes,
  };
}
