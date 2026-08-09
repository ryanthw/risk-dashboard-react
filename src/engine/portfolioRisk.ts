/**
 * Aggregate risk analytics that sit on top of the per-trade TradeMetrics
 * deriveTradeMetrics already produces. Nothing here re-runs a simulation — it
 * reuses the existing pnlDist/greeks bundles, so it is cheap to recompute.
 */
import type { Trade } from "@/types";
import type { Position } from "./portfolio";
import { var95, cvar95 } from "./monteCarlo";

/** Dollar greeks for the book. theta is $/day, vega is $ per 1 vol point. */
export interface PortfolioGreeks {
  /** $ P&L per $1 move in the underlying. Only meaningful per-ticker; across
   *  tickers use betaWeightedDelta instead. */
  dollarDelta: number;
  theta: number;
  vega: number;
}

export function portfolioGreeks(positions: Position[]): PortfolioGreeks {
  let dollarDelta = 0;
  let theta = 0;
  let vega = 0;
  for (const { metrics } of positions) {
    dollarDelta += metrics.greeks.delta;
    theta += metrics.greeks.theta;
    vega += metrics.greeks.vega;
  }
  return { dollarDelta, theta, vega };
}

export interface TailRisk {
  /** 5th-percentile P&L of the summed distribution. Negative = loss. */
  var95: number;
  /** Mean of the worst 5% of the summed distribution. */
  cvar95: number;
  /** Sum of each leg's own VaR95 — the perfectly-correlated upper bound. */
  comonotonicVar95: number;
  /** How many option legs went into the estimate. */
  legs: number;
}

/**
 * Tail risk for the option book held to expiry.
 *
 * Two caveats that the UI must not paper over:
 *  - Each trade simulates its own independent gaussians, so summing the
 *    distributions element-wise assumes *zero* correlation between underlyings.
 *    For a concentrated book that understates the tail. `comonotonicVar95` is
 *    the opposite extreme (perfect correlation); the truth sits between them.
 *  - Shares are excluded. simulatePayoff hardcodes T = 1 year for shares, so
 *    mixing them in would blend a 1-year distribution with 30-day ones and the
 *    result would have no coherent horizon.
 */
export function expiryTailRisk(positions: Position[]): TailRisk | null {
  // Both estimates must be built from the identical set of legs, or the bound
  // isn't a bound — it's a comparison of two different books.
  const legs = positions.filter((p) => p.trade.trade_type !== "shares");
  const dists = legs.map((p) => p.metrics.pnlDist);
  if (dists.length === 0) return null;

  const n = dists[0].length;
  const total = new Float64Array(n);
  for (const d of dists) {
    // Defensive: a differing sim count would silently truncate the sum.
    const len = Math.min(n, d.length);
    for (let i = 0; i < len; i++) total[i] += d[i];
  }

  let comonotonic = 0;
  for (const d of dists) {
    if (d.length > 0) comonotonic += var95(d);
  }

  return {
    var95: var95(total),
    cvar95: cvar95(total),
    comonotonicVar95: comonotonic,
    legs: dists.length,
  };
}

/** The strike that is actually short for a position, or null if it has none. */
export function shortStrike(trade: Trade): { strike: number; kind: "put" | "call" } | null {
  const K1 = trade.strike ?? 0;
  const K2 = trade.strike_2 ?? 0;
  switch (trade.trade_type) {
    case "csp":
    case "short_put":
      return { strike: K1, kind: "put" };
    case "cc":
    case "short_call":
      return { strike: K1, kind: "call" };
    // For spreads the short leg is structural, not positional: the short put is
    // always the higher strike and the short call always the lower one, so read
    // it off the pair rather than trusting which column it landed in.
    case "pcs":
      return { strike: Math.max(K1, K2), kind: "put" };
    case "ccs":
      return { strike: Math.min(K1, K2), kind: "call" };
    default:
      return null;
  }
}

export interface AssignmentRisk {
  position: Position;
  strike: number;
  kind: "put" | "call";
  /** How far in-the-money, as a % of the strike. */
  itmPct: number;
}

/** Short legs currently in-the-money — the positions that can be assigned. */
export function assignmentRisks(positions: Position[]): AssignmentRisk[] {
  const out: AssignmentRisk[] = [];
  for (const position of positions) {
    const short = shortStrike(position.trade);
    if (!short) continue;
    const S = position.trade.underlying_price ?? 0;
    if (S <= 0) continue;
    const itm = short.kind === "put" ? S < short.strike : S > short.strike;
    if (!itm) continue;
    out.push({
      position,
      strike: short.strike,
      kind: short.kind,
      itmPct: (Math.abs(S - short.strike) / short.strike) * 100,
    });
  }
  return out.sort((a, b) => b.itmPct - a.itmPct);
}

/** Open option positions expiring within `days`. */
export function expiringWithin(positions: Position[], days: number): Position[] {
  return positions
    .filter((p) => p.trade.trade_type !== "shares" && p.metrics.dte <= days)
    .sort((a, b) => a.metrics.dte - b.metrics.dte);
}

/** Days to the nearest expiration, or null when nothing is dated. */
export function nearestDte(positions: Position[]): number | null {
  const dtes = positions
    .filter((p) => p.trade.expiration)
    .map((p) => p.metrics.dte);
  return dtes.length ? Math.min(...dtes) : null;
}

export interface LargestRisk {
  ticker: string;
  maxLoss: number;
  pctOfValue: number;
}

/**
 * The single ticker carrying the most defined risk, aggregated across trades.
 * Naked short calls report an infinite max loss, so they are excluded from the
 * ranking rather than swallowing it — the UI flags them separately.
 */
export function largestTickerRisk(
  positions: Position[],
  portValue: number,
): LargestRisk | null {
  const byTicker = new Map<string, number>();
  for (const { trade, metrics } of positions) {
    if (!Number.isFinite(metrics.maxLoss)) continue;
    byTicker.set(trade.ticker, (byTicker.get(trade.ticker) ?? 0) + Math.abs(metrics.maxLoss));
  }
  let best: LargestRisk | null = null;
  for (const [ticker, maxLoss] of byTicker) {
    if (!best || maxLoss > best.maxLoss) {
      best = {
        ticker,
        maxLoss,
        pctOfValue: portValue > 0 ? (maxLoss / portValue) * 100 : 0,
      };
    }
  }
  return best;
}

/** Count of positions with theoretically unbounded loss (naked short calls). */
export function undefinedRiskCount(positions: Position[]): number {
  return positions.filter((p) => !Number.isFinite(p.metrics.maxLoss)).length;
}
