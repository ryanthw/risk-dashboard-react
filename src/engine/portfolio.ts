/**
 * Portfolio-level risk math. Ported 1:1 from utils.py and the
 * database_sq.get_portfolio_val logic.
 *
 * Operates on positions that already carry their computed TradeMetrics, so the
 * heavy Monte-Carlo work is done once per trade and reused across every metric.
 */
import { CREDIT_TYPES, type Trade } from "@/types";
import type { TradeMetrics } from "./trade";

export interface Position {
  trade: Trade;
  metrics: TradeMetrics;
}

const isCredit = (t: Trade) => CREDIT_TYPES.includes(t.trade_type);

/** Total portfolio value: cash + value of all non-credit positions. */
export function portfolioValue(positions: Position[], cash: number): number {
  let val = cash;
  for (const { trade, metrics } of positions) {
    if (!isCredit(trade)) val += metrics.value;
  }
  return val;
}

/** Gross exposure = sum of all positions' max loss. */
export function grossExposure(positions: Position[]): number {
  let sum = 0;
  for (const { metrics } of positions) {
    if (Number.isFinite(metrics.maxLoss)) sum += metrics.maxLoss;
  }
  return sum;
}

export function percentExposure(positions: Position[], cash: number): number {
  const val = portfolioValue(positions, cash);
  return val > 0 ? (grossExposure(positions) / val) * 100 : 0;
}

export function cashPercent(positions: Position[], cash: number): number {
  const val = portfolioValue(positions, cash);
  const udp_cash = undeployedCash(positions, cash);
  return val > 0 ? (udp_cash / val) * 100 : 0;
}

export function cashToPosRatio(positions: Position[], cash: number): number {
  const posVal = positions.reduce((a, p) => a + p.metrics.value, 0);
  return posVal > 0 ? cash / posVal : 1;
}

export function leverageRatio(positions: Position[], cash: number): number {
  const val = portfolioValue(positions, cash);
  return val > 0 ? grossExposure(positions) / val : 0;
}

export function highestPosPercent(positions: Position[], cash: number): number {
  const val = portfolioValue(positions, cash);
  let highest = 0;
  for (const { metrics } of positions) {
    if (Number.isFinite(metrics.maxLoss) && metrics.maxLoss > highest) {
      highest = metrics.maxLoss;
    }
  }
  return val > 0 ? (highest / val) * 100 : 0;
}

/** Herfindahl-Hirschman concentration index over ticker exposure. */
export function hhi(positions: Position[]): number {
  const exp = grossExposure(positions);
  if (exp <= 0 || positions.length === 0) return 0;
  const byTicker: Record<string, number> = {};
  for (const { trade, metrics } of positions) {
    if (!Number.isFinite(metrics.maxLoss)) continue;
    byTicker[trade.ticker] = (byTicker[trade.ticker] ?? 0) + metrics.maxLoss;
  }
  let h = 0;
  for (const loss of Object.values(byTicker)) {
    const w = loss / exp;
    h += w * w;
  }
  return h;
}

/** Expected returns over option positions (sum of expected profit). */
export function expectedReturnsList(positions: Position[]): number[] {
  return positions
    .filter((p) => p.trade.trade_type !== "shares")
    .map((p) => p.metrics.expectedProfit);
}

export function expectedReturns(positions: Position[]): number {
  return expectedReturnsList(positions).reduce((a, b) => a + b, 0);
}

export function maxProfit(positions: Position[]): number {
  return positions.reduce((a, p) => a + p.metrics.maxGain, 0);
}

export function riskRewardRatio(positions: Position[]): number {
  const mp = maxProfit(positions);
  return mp > 0 ? grossExposure(positions) / mp : 0;
}

/** Expected return as % of portfolio value (short-term ER%). */
export function erPercent(positions: Position[], cash: number): number {
  const er = expectedReturns(positions);
  const val = portfolioValue(positions, cash);
  return val > 0 ? (er / val) * 100 : 0;
}

/** Weighted annualized expected return (decimal). Mirrors get_er_ann. */
export function erAnn(positions: Position[], cash: number): number {
  const val = portfolioValue(positions, cash);
  if (positions.length === 0 || val <= 0) return 0;
  let acc = 0;
  for (const { trade, metrics } of positions) {
    if (trade.trade_type === "shares" || trade.trade_type === "cc") continue;
    const maxLossAbs = Math.abs(metrics.maxLoss);
    if (!Number.isFinite(maxLossAbs) || maxLossAbs === 0) continue;
    const days = metrics.posLen > 0 ? metrics.posLen : 1;
    const cycleYield = metrics.expectedProfit / maxLossAbs;
    const annual = cycleYield * (365 / days);
    const w = maxLossAbs / val;
    acc += w * annual;
  }
  return acc;
}

export function costToCloseShorts(positions: Position[]): number {
  let cost = 0;
  for (const { trade, metrics } of positions) {
    if (["csp", "cc", "short_call", "short_put", "pcs", "ccs"].includes(trade.trade_type)) {
      cost += metrics.value - metrics.expectedProfit;
    }
  }
  return cost;
}

export function longOptionsVals(positions: Position[]): number {
  let cost = 0;
  for (const { trade, metrics } of positions) {
    if (["long_call", "long_put", "cds", "pds"].includes(trade.trade_type)) {
      cost += metrics.value + metrics.expectedProfit;
    }
  }
  return cost;
}

/** Net liquidity: cash + shares value - cost to close shorts + long option value. */
export function netLiquidity(positions: Position[], cash: number): number {
  let liq = cash;
  for (const { trade, metrics } of positions) {
    if (trade.trade_type === "shares") liq += metrics.value;
  }
  liq -= costToCloseShorts(positions);
  liq += longOptionsVals(positions);
  return liq;
}

export function undeployedCash(positions: Position[], cash: number): number {
  let c = cash;
  for (const { trade, metrics } of positions) {
    if (["csp", "pcs", "ccs"].includes(trade.trade_type)) c -= metrics.maxLoss;
  }
  return c;
}

/** Approximate beta-weighted delta using per-strategy delta heuristics. */
export function betaWeightedDelta(positions: Position[]): number {
  let total = 0;
  for (const { trade } of positions) {
    const beta = trade.beta ?? 1;
    const qty = trade.qty;
    const t = trade.trade_type;
    let raw = 0;
    if (t === "shares") raw = qty;
    else if (t === "csp" || t === "short_put") raw = 0.5 * 100 * qty;
    else if (t === "cc" || t === "short_call") raw = -0.5 * 100 * qty;
    else if (t === "pcs") raw = 0.25 * 100 * qty;
    else if (t === "ccs") raw = -0.25 * 100 * qty;
    else if (t === "long_call" || t === "cds") raw = 0.4 * 100 * qty;
    else if (t === "long_put" || t === "pds") raw = -0.4 * 100 * qty;
    total += raw * beta;
  }
  return total;
}

export function percentRiskPosition(position: Position, portVal: number): number {
  return portVal > 0 ? (position.metrics.maxLoss / portVal) * 100 : 0;
}

/** Per-strategy delta heuristic for a single trade (used in sandbox impact). */
export function tradeBetaDelta(trade: Trade): number {
  const beta = trade.beta ?? 1;
  const qty = trade.qty;
  const t = trade.trade_type;
  let raw = 0;
  if (t === "shares") raw = qty;
  else if (t === "csp" || t === "short_put") raw = 0.5 * 100 * qty;
  else if (t === "cc" || t === "short_call") raw = -0.5 * 100 * qty;
  else if (t === "pcs") raw = 0.25 * 100 * qty;
  else if (t === "ccs") raw = -0.25 * 100 * qty;
  else if (t === "long_call" || t === "cds") raw = 0.4 * 100 * qty;
  else if (t === "long_put" || t === "pds") raw = -0.4 * 100 * qty;
  return raw * beta;
}

export interface SnapshotMetrics {
  net_liquidity: number;
  weighted_delta: number;
  expected_profit_total: number;
  erpa: number;
}

/** Snapshot metrics captured on refresh. Mirrors capture_and_save_snapshot. */
export function snapshotMetrics(positions: Position[], cash: number): SnapshotMetrics {
  const netLiq = netLiquidity(positions, cash);
  const weightedDelta = betaWeightedDelta(positions);
  const totalExpProfit = expectedReturns(positions);
  const portVal = portfolioValue(positions, cash);
  const erpa = portVal > 0 ? totalExpProfit / portVal : 0;
  return {
    net_liquidity: netLiq,
    weighted_delta: weightedDelta,
    expected_profit_total: totalExpProfit,
    erpa,
  };
}
