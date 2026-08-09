/**
 * Monte Carlo payoff simulation and empirical risk statistics.
 * Ported 1:1 from trade.py (simulate_payoff, get_payoff_at_prices,
 * pop, expected_profit, var_95, cvar_95, kelly_criterion).
 */
import type { TradeType } from "@/types";

export interface Payoffable {
  trade_type: TradeType;
  qty: number;
  strike: number | null;
  strike_2: number | null;
  premium: number | null;
  underlying_price: number | null;
  iv: number;
}

/** Box-Muller standard-normal generator. */
function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Terminal P&L distribution under GBM with antithetic variates.
 * dteYears: current time-to-expiry in years (use 1.0 for shares, like the original).
 */
export function simulatePayoff(
  trade: Payoffable,
  dteYears: number,
  sims = 50_000,
  mu = 0,
  /**
   * Forces the simulation horizon in years, overriding the per-type default.
   * Needed to line shares up with the option book: shares have no expiry, so
   * they otherwise default to 1 year and can't be summed with 30-day legs.
   */
  horizonYears?: number,
): Float64Array {
  const S0 = trade.underlying_price ?? 0;
  const iv = trade.iv;
  const T =
    horizonYears != null
      ? Math.max(horizonYears, 0)
      : trade.trade_type === "shares"
        ? 1.0
        : Math.max(dteYears, 0);

  const half = Math.floor(sims / 2);
  const ST = new Float64Array(half * 2);
  const drift = (mu - 0.5 * iv * iv) * T;
  const diff = iv * Math.sqrt(T);

  for (let i = 0; i < half; i++) {
    const z = gaussian();
    ST[i] = S0 * Math.exp(drift + diff * z);
    ST[half + i] = S0 * Math.exp(drift + diff * -z); // antithetic
  }
  return payoffAtPrices(trade, ST);
}

/** Payoff for an array of terminal prices. Mirrors get_payoff_at_prices. */
export function payoffAtPrices(
  trade: Payoffable,
  ST: ArrayLike<number>,
): Float64Array {
  const S0 = trade.underlying_price ?? 0;
  const K1 = trade.strike ?? 0;
  const K2 = trade.strike_2 ?? 0;
  const qty = trade.qty;
  const premium = trade.premium ?? 0;
  const mult = 100 * qty;
  const t = trade.trade_type;
  const n = ST.length;
  const out = new Float64Array(n);

  const max = Math.max;

  for (let i = 0; i < n; i++) {
    const s = ST[i];
    let p = 0;
    switch (t) {
      case "long_call":
        p = max(s - K1, 0) * mult - premium * mult;
        break;
      case "long_put":
        p = max(K1 - s, 0) * mult - premium * mult;
        break;
      case "short_call":
        p = -max(s - K1, 0) * mult + premium * mult;
        break;
      case "short_put":
      case "csp":
        p = -max(K1 - s, 0) * mult + premium * mult;
        break;
      case "pcs": {
        const shortPnl = -max(K1 - s, 0) * mult;
        const longPnl = K2 ? max(K2 - s, 0) * mult : 0;
        p = shortPnl + longPnl + premium * mult;
        break;
      }
      case "ccs": {
        const shortPnl = -max(s - K1, 0) * mult;
        const longPnl = K2 ? max(s - K2, 0) * mult : 0;
        p = shortPnl + longPnl + premium * mult;
        break;
      }
      case "cds": {
        const longPnl = max(s - K1, 0) * mult;
        const shortPnl = K2 ? -max(s - K2, 0) * mult : 0;
        p = longPnl + shortPnl - Math.abs(premium) * mult;
        break;
      }
      case "pds": {
        const longPnl = max(K1 - s, 0) * mult;
        const shortPnl = K2 ? -max(K2 - s, 0) * mult : 0;
        p = longPnl + shortPnl - Math.abs(premium) * mult;
        break;
      }
      case "cc":
        // A cc row is the written call only — the covering shares or LEAPS are
        // tracked as their own position (see deriveBasisPositions, which
        // allocates cc contracts against them). Carrying a stock leg here would
        // double-count the underlying, so the payoff is a plain short call.
        p = -max(s - K1, 0) * mult + premium * mult;
        break;
      case "shares":
        p = (s - S0) * qty;
        break;
      default:
        p = 0;
    }
    out[i] = p;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Empirical statistics over a P&L distribution
// ---------------------------------------------------------------------------

export function mean(arr: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return arr.length ? sum / arr.length : 0;
}

export function stdDev(arr: ArrayLike<number>): number {
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    s += d * d;
  }
  return arr.length ? Math.sqrt(s / arr.length) : 0;
}

/** Probability of profit: fraction of paths with P&L > 0. */
export function pop(pnl: ArrayLike<number>): number {
  if (!pnl.length) return 0;
  let wins = 0;
  for (let i = 0; i < pnl.length; i++) if (pnl[i] > 0) wins++;
  return wins / pnl.length;
}

export const expectedProfit = mean;

/** P-th percentile (linear interpolation, matches numpy.percentile default). */
export function percentile(arr: ArrayLike<number>, p: number): number {
  if (!arr.length) return 0;
  const sorted = Float64Array.from(arr).sort();
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Value at Risk (95%): 5th percentile of P&L. */
export function var95(pnl: ArrayLike<number>): number {
  return percentile(pnl, 5);
}

/** Conditional VaR (95%): mean of the worst-5% tail. */
export function cvar95(pnl: ArrayLike<number>): number {
  if (!pnl.length) return 0;
  const v = var95(pnl);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < pnl.length; i++) {
    if (pnl[i] <= v) {
      sum += pnl[i];
      count++;
    }
  }
  return count ? sum / count : v;
}

/** Half-Kelly suggested allocation fraction. */
export function kelly(pnl: ArrayLike<number>): number {
  if (!pnl.length) return 0;
  let winSum = 0;
  let winCount = 0;
  let lossSum = 0;
  let lossCount = 0;
  for (let i = 0; i < pnl.length; i++) {
    const x = pnl[i];
    if (x > 0) {
      winSum += x;
      winCount++;
    } else if (x < 0) {
      lossSum += x;
      lossCount++;
    }
  }
  if (lossCount === 0) return 1.0;
  if (winCount === 0) return 0.0;
  const avgWin = winSum / winCount;
  const avgLoss = Math.abs(lossSum / lossCount);
  const W = pop(pnl);
  const R = avgWin / avgLoss;
  const k = W - (1 - W) / R;
  return Math.max(0, k * 0.5);
}
