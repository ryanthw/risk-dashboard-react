/**
 * Per-trade derived metrics: dte, value, max gain/loss, and the full
 * Monte-Carlo risk bundle (POP, EV, VaR, CVaR, Kelly) + Greeks.
 * Ported from trade.py properties.
 */
import type { Trade } from "@/types";
import { greeks, type Greeks } from "./blackScholes";
import {
  simulatePayoff,
  pop,
  expectedProfit,
  var95,
  cvar95,
  kelly,
  stdDev,
} from "./monteCarlo";

const MS_PER_DAY = 86_400_000;

/** Fractional days to expiration from now (clamped >= 0). */
export function dteDays(trade: Pick<Trade, "expiration">, now = Date.now()): number {
  if (!trade.expiration) return 0;
  const exp = new Date(`${trade.expiration}T00:00:00`).getTime();
  return Math.max((exp - now) / MS_PER_DAY, 0);
}

/** Full position lifetime in days (open -> expiration). */
export function posLenDays(trade: Pick<Trade, "expiration" | "opened_at">): number {
  if (!trade.expiration) return 1;
  const exp = new Date(`${trade.expiration}T00:00:00`).getTime();
  const opened = new Date(trade.opened_at).getTime();
  const len = (exp - opened) / MS_PER_DAY;
  return len > 0 ? len : 1;
}

/** Mark value of the position (premium*100*qty for options, S*qty for shares). */
export function tradeValue(trade: Trade): number {
  if (trade.trade_type === "shares") {
    return (trade.underlying_price ?? 0) * trade.qty;
  }
  return Math.abs(trade.premium ?? 0) * 100 * trade.qty;
}

/** Maximum gain by strategy. Ported from Trade.max_gain. */
export function maxGain(trade: Trade): number {
  const t = trade.trade_type;
  const qty = trade.qty;
  const prem = trade.premium ?? 0;
  const K1 = trade.strike ?? 0;
  const K2 = trade.strike_2 ?? 0;
  const S = trade.underlying_price ?? 0;

  switch (t) {
    case "shares":
      return tradeValue(trade) * 0.5;
    case "csp":
    case "short_put":
    case "short_call":
    case "ccs":
    case "pcs":
      return prem * 100 * qty;
    case "cc":
      return (K1 - S + prem) * 100 * qty;
    case "cds":
    case "pds":
      return (Math.abs(K2 - K1) - Math.abs(prem)) * 100 * qty;
    case "long_call":
      return prem * 4;
    case "long_put":
      return (K1 - Math.abs(prem)) * 100 * qty;
    default:
      return 0;
  }
}

/** Maximum loss by strategy. Ported from Trade.max_loss. */
export function maxLoss(trade: Trade): number {
  const t = trade.trade_type;
  const qty = trade.qty;
  const prem = trade.premium ?? 0;
  const K1 = trade.strike ?? 0;
  const K2 = trade.strike_2 ?? 0;
  const S = trade.underlying_price ?? 0;

  switch (t) {
    case "shares":
      return S * qty;
    case "csp":
    case "short_put":
      return (K1 - prem) * 100 * qty;
    case "cc":
      return 0;
    case "short_call":
      return Infinity;
    case "long_call":
    case "long_put":
    case "cds":
    case "pds":
      return prem * 100 * qty;
    case "ccs":
    case "pcs":
      return (Math.abs(K2 - K1) - Math.abs(prem)) * 100 * qty;
    default:
      return 0;
  }
}

export interface TradeMetrics {
  value: number;
  maxGain: number;
  maxLoss: number;
  dte: number;
  posLen: number;
  pnlDist: Float64Array;
  pop: number;
  expectedProfit: number;
  stdDev: number;
  var95: number;
  cvar95: number;
  kelly: number;
  greeks: Greeks;
}

/**
 * Compute every derived metric for a trade, running a fresh Monte-Carlo
 * simulation. Memoize callers — this is the heavy call.
 */
export function deriveTradeMetrics(trade: Trade, sims = 50_000): TradeMetrics {
  const dte = dteDays(trade);
  const pnlDist = simulatePayoff(trade, dte / 365, sims);
  return {
    value: tradeValue(trade),
    maxGain: maxGain(trade),
    maxLoss: maxLoss(trade),
    dte,
    posLen: posLenDays(trade),
    pnlDist,
    pop: pop(pnlDist),
    expectedProfit: expectedProfit(pnlDist),
    stdDev: stdDev(pnlDist),
    var95: var95(pnlDist),
    cvar95: cvar95(pnlDist),
    kelly: kelly(pnlDist),
    greeks: greeks(trade, dte / 365),
  };
}
