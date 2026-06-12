/**
 * Black-Scholes pricing, normal CDF, theoretical position value, and Greeks.
 * Ported 1:1 from trade.py (_bs_price, get_theoretical_value, greeks).
 */
import type { TradeType } from "@/types";

export const RISK_FREE_RATE = 0.04;

/** Error function (Abramowitz & Stegun 7.1.26), ~1e-7 accuracy. */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/** Standard normal cumulative distribution function (replaces scipy.norm.cdf). */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Standard normal probability density function. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export type OptionType = "call" | "put";

/** Black-Scholes price for a single option (per share). */
export function bsPrice(
  S: number,
  K: number,
  T: number,
  sigma: number,
  r = RISK_FREE_RATE,
  optionType: OptionType = "call",
): number {
  if (T <= 0 || sigma <= 0) {
    return optionType === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  if (optionType === "call") {
    return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  }
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

/** Minimal shape the pricing functions need from a position. */
export interface Priceable {
  trade_type: TradeType;
  qty: number;
  strike: number | null;
  strike_2: number | null;
  underlying_price: number | null;
  iv: number;
}

/**
 * Theoretical mark-to-market value of the whole position given a price S,
 * time-to-expiry T (years) and vol iv. Mirrors get_theoretical_value.
 */
export function theoreticalValue(
  trade: Priceable,
  S: number,
  T: number,
  iv: number,
  r = RISK_FREE_RATE,
): number {
  const mult = 100 * trade.qty;
  const t = trade.trade_type;
  const K1 = trade.strike ?? 0;
  const K2 = trade.strike_2 ?? 0;

  if (t === "shares") return S * trade.qty;

  if (t === "long_call" || t === "short_call") {
    const v = bsPrice(S, K1, T, iv, r, "call") * mult;
    return t === "long_call" ? v : -v;
  }
  if (t === "long_put" || t === "short_put" || t === "csp") {
    const v = bsPrice(S, K1, T, iv, r, "put") * mult;
    return t === "long_put" ? v : -v;
  }
  if (t === "pcs" || t === "pds") {
    const v1 = bsPrice(S, K1, T, iv, r, "put") * mult;
    const v2 = bsPrice(S, K2, T, iv, r, "put") * mult;
    return t === "pcs" ? -v1 + v2 : v1 - v2;
  }
  if (t === "ccs" || t === "cds") {
    const v1 = bsPrice(S, K1, T, iv, r, "call") * mult;
    const v2 = bsPrice(S, K2, T, iv, r, "call") * mult;
    return t === "ccs" ? -v1 + v2 : v1 - v2;
  }
  if (t === "cc") {
    const stockVal = S * trade.qty;
    const callVal = bsPrice(S, K1, T, iv, r, "call") * mult;
    return stockVal - callVal;
  }
  return 0;
}

export interface Greeks {
  delta: number;
  theta: number; // daily
  vega: number; // per 1 vol point
}

/**
 * Finite-difference Greeks for the position. Identical shifts to trade.py:
 * 1% price, 1% vol, 1 day. dteYears is current time-to-expiry in years.
 */
export function greeks(trade: Priceable, dteYears: number): Greeks {
  if (trade.trade_type === "shares") {
    return { delta: trade.qty, theta: 0, vega: 0 };
  }
  const S = trade.underlying_price ?? 0;
  const T = dteYears;
  const iv = trade.iv;

  const v0 = theoreticalValue(trade, S, T, iv);

  const ds = S * 0.01;
  const delta = ds > 0 ? (theoreticalValue(trade, S + ds, T, iv) - v0) / ds : 0;

  const dv = 0.01;
  const vega = (theoreticalValue(trade, S, T, iv + dv) - v0) / (dv * 100);

  const dt = 1 / 365;
  const theta = theoreticalValue(trade, S, Math.max(0, T - dt), iv) - v0;

  return { delta, theta, vega };
}
