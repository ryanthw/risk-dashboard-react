/**
 * Aggregate risk analytics that sit on top of the per-trade TradeMetrics
 * deriveTradeMetrics already produces. Nothing here re-runs a simulation — it
 * reuses the existing pnlDist/greeks bundles, so it is cheap to recompute.
 */
import { isSpread, type Trade } from "@/types";
import type { Position } from "./portfolio";
import { simulatePayoff, var95, cvar95 } from "./monteCarlo";
import { isCreditSpread, spreadLegs } from "./spread";

/** Must match deriveTradeMetrics' default so summed distributions line up. */
const SIMS = 50_000;

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
  /** How many positions went into the estimate. */
  legs: number;
  /** Horizon the book was carried to, in days — the last option expiry. */
  horizonDays: number;
}

/**
 * Tail risk for the book carried to the last option expiry.
 *
 * Stock positions are included, re-simulated at that same horizon rather than
 * their default 1-year one. That matters because a `cc` row is only the written
 * call: without the covering shares or LEAPS in the sum, every covered call
 * would score as a naked short call and the tail would be badly overstated.
 *
 * The caveat the UI must not paper over: each trade draws its own independent
 * gaussians, so summing the distributions element-wise assumes *zero*
 * correlation between underlyings, which understates the tail for a
 * concentrated book. `comonotonicVar95` is the opposite extreme (perfect
 * correlation); the truth sits between the two.
 */
export function expiryTailRisk(positions: Position[]): TailRisk | null {
  const optionLegs = positions.filter((p) => p.trade.trade_type !== "shares");
  if (optionLegs.length === 0) return null;

  // Carry stock to the last option expiry so both sides share one horizon.
  const horizonDays = Math.max(...optionLegs.map((p) => p.metrics.dte));
  const shareLegs = positions.filter((p) => p.trade.trade_type === "shares");

  // Both estimates must be built from the identical set of legs, or the bound
  // isn't a bound — it's a comparison of two different books.
  const dists = [
    ...optionLegs.map((p) => p.metrics.pnlDist),
    ...shareLegs.map((p) =>
      simulatePayoff(p.trade, horizonDays / 365, SIMS, 0, horizonDays / 365),
    ),
  ];

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
    horizonDays,
  };
}

/** The strike that is actually short for a position, or null if it has none. */
export function shortStrike(trade: Trade): { strike: number; kind: "put" | "call" } | null {
  const K1 = trade.strike ?? 0;
  switch (trade.trade_type) {
    case "csp":
    case "short_put":
      return { strike: K1, kind: "put" };
    case "cc":
    case "short_call":
      return { strike: K1, kind: "call" };
    default: {
      // Every spread has a short leg, debit ones included — a call debit spread
      // is short the higher call, a put debit spread the lower put. Which one
      // is structural rather than positional, so it is read off the pair.
      const legs = spreadLegs(trade.trade_type, trade.strike, trade.strike_2);
      if (!legs || legs.short == null) return null;
      return { strike: legs.short, kind: legs.kind };
    }
  }
}

export interface AssignmentRisk {
  position: Position;
  strike: number;
  kind: "put" | "call";
  /** How far in-the-money, as a % of the strike. */
  itmPct: number;
  /**
   * True when the ITM short leg is the *good* outcome: a debit spread pays its
   * maximum precisely when its short leg finishes in the money. What is at
   * stake there is early assignment, not loss — being assigned leaves stock to
   * deal with while the long leg is still open, which a cash account cannot
   * carry. Credit spreads and naked shorts are the opposite case: ITM means the
   * position has moved against you.
   */
  atMaxProfit: boolean;
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
      atMaxProfit:
        isSpread(position.trade.trade_type) &&
        !isCreditSpread(position.trade.trade_type),
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
