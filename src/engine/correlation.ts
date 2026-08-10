/**
 * Portfolio-level correlation scoring.
 *
 * The input is a correlation matrix of the *underlyings*. What matters for risk
 * is whether the **positions** move together, which is not the same thing: a
 * long put on SPY and long calls on QQQ sit on underlyings correlated ~0.95,
 * yet the two positions hedge each other. Scoring the raw underlying matrix
 * calls that pair dangerous when it is the opposite.
 *
 * So each ticker's net directional sign is applied to the pair before it is
 * scored. Opposing exposures on correlated names count as diversification;
 * aligned exposures on correlated names count as concentration.
 */
import type { Position } from "./portfolio";
import { tradeBetaDelta } from "./portfolio";

export interface TickerExposure {
  /** Capital at risk on the ticker, used as the pair weight. */
  risk: number;
  /** +1 for net long the underlying, -1 for net short. */
  direction: 1 | -1;
}

/**
 * Net risk and direction per ticker. Direction comes from the summed
 * beta-weighted delta heuristic, so a ticker holding both a CSP and a long put
 * nets out rather than being counted twice in the same direction.
 */
export function tickerExposures(positions: Position[]): Map<string, TickerExposure> {
  const risk = new Map<string, number>();
  const delta = new Map<string, number>();
  for (const { trade, metrics } of positions) {
    const r = Number.isFinite(metrics.maxLoss) ? Math.abs(metrics.maxLoss) : 0;
    risk.set(trade.ticker, (risk.get(trade.ticker) ?? 0) + r);
    delta.set(trade.ticker, (delta.get(trade.ticker) ?? 0) + tradeBetaDelta(trade));
  }
  const out = new Map<string, TickerExposure>();
  for (const [ticker, r] of risk) {
    // A net-flat ticker has no direction to speak of; treat it as long so it
    // still participates rather than silently flipping every pair it touches.
    out.set(ticker, { risk: r, direction: (delta.get(ticker) ?? 0) < 0 ? -1 : 1 });
  }
  return out;
}

export interface CorrelationPair {
  pair: string;
  /** Correlation of the underlyings. */
  rawCorr: number;
  /** Sign-adjusted: how the two *positions* move together. */
  effectiveCorr: number;
  /** Share of the weighted average this pair accounts for, 0-1. */
  weight: number;
}

export interface AntiCorrelationResult {
  /**
   * 1 − weighted mean effective correlation. 1.0 means uncorrelated; below 1
   * means the book's positions reinforce each other; above 1 means they
   * genuinely offset. Range is 0 to 2.
   */
  score: number;
  avgCorrelation: number;
  /** Pairs that compound risk — aligned exposure on correlated underlyings. */
  flags: CorrelationPair[];
  pairs: number;
}

/** Effective correlation above this is treated as risk that compounds. */
export const COMPOUNDING_THRESHOLD = 0.75;

export function antiCorrelation(
  tickers: string[],
  matrix: number[][],
  exposures: Map<string, TickerExposure>,
): AntiCorrelationResult | null {
  if (tickers.length < 2) return null;

  const totalRisk = tickers.reduce((a, t) => a + (exposures.get(t)?.risk ?? 0), 0);
  if (totalRisk <= 0) return null;

  const weightOf = (t: string) => (exposures.get(t)?.risk ?? 0) / totalRisk;
  const signOf = (t: string) => exposures.get(t)?.direction ?? 1;

  let weightedSum = 0;
  let weightTotal = 0;
  const all: CorrelationPair[] = [];

  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const t1 = tickers[i];
      const t2 = tickers[j];
      const rawCorr = matrix[i][j];
      const effectiveCorr = rawCorr * signOf(t1) * signOf(t2);
      const w = weightOf(t1) * weightOf(t2);
      weightedSum += effectiveCorr * w;
      weightTotal += w;
      all.push({ pair: `${t1} / ${t2}`, rawCorr, effectiveCorr, weight: w });
    }
  }

  if (weightTotal <= 0) return null;
  const avgCorrelation = weightedSum / weightTotal;

  for (const p of all) p.weight /= weightTotal;

  return {
    score: 1 - avgCorrelation,
    avgCorrelation,
    flags: all
      .filter((p) => p.effectiveCorr > COMPOUNDING_THRESHOLD)
      .sort((a, b) => b.weight - a.weight),
    pairs: all.length,
  };
}
