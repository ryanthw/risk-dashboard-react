/**
 * Technical risk grade for a basis position's underlying, computed from ~1y of
 * daily closes. Deterministic weighted checklist (weights sum to 100); factors
 * that lack history (e.g. 200-SMA on a recent IPO) are dropped and the score is
 * renormalized over the factors that could be evaluated.
 */

export interface RiskFactor {
  label: string;
  ok: boolean;
  detail: string;
  weight: number;
}

export type GradeLetter = "A" | "B" | "C" | "D" | "F";

export interface RiskGrade {
  score: number; // 0-100
  grade: GradeLetter;
  factors: RiskFactor[];
}

function sma(closes: number[], window: number, endOffset = 0): number | null {
  const end = closes.length - endOffset;
  if (end - window < 0) return null;
  let s = 0;
  for (let i = end - window; i < end; i++) s += closes[i];
  return s / window;
}

function letter(score: number): GradeLetter {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

/**
 * closes: chronological daily closes (ideally ~252 sessions / 1 year).
 * spot: current price. Returns null when there's too little history to say
 * anything useful (< ~3 months).
 */
export function riskGrade(closes: number[], spot: number): RiskGrade | null {
  if (spot <= 0 || closes.length < 60) return null;

  const factors: RiskFactor[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  const addSmaFactor = (window: number, weight: number) => {
    const m = sma(closes, window);
    if (m == null || m <= 0) return;
    factors.push({
      label: `Above ${window}-day SMA`,
      ok: spot > m,
      detail: `${pct(spot / m - 1)} vs $${m.toFixed(2)}`,
      weight,
    });
  };
  addSmaFactor(15, 10);
  addSmaFactor(50, 15);
  addSmaFactor(200, 20);

  // Trend: 50-SMA slope over the last ~month of sessions.
  const sma50Now = sma(closes, 50);
  const sma50Prior = sma(closes, 50, 20);
  if (sma50Now != null && sma50Prior != null && sma50Prior > 0) {
    factors.push({
      label: "50-day SMA rising",
      ok: sma50Now > sma50Prior,
      detail: `${pct(sma50Now / sma50Prior - 1)} over ~1 month`,
      weight: 15,
    });
  }

  // Momentum: higher than ~3 months ago.
  if (closes.length >= 63) {
    const prior = closes[closes.length - 63];
    if (prior > 0) {
      factors.push({
        label: "Up over 3 months",
        ok: spot > prior,
        detail: `${pct(spot / prior - 1)} vs $${prior.toFixed(2)}`,
        weight: 10,
      });
    }
  }

  // Proximity to lows — near the low means the market keeps rejecting the name.
  const low52 = Math.min(...closes.slice(-252), spot);
  const low26 = Math.min(...closes.slice(-126), spot);
  if (low52 > 0) {
    factors.push({
      label: "≥15% off 52-week low",
      ok: spot / low52 - 1 >= 0.15,
      detail: `${pct(spot / low52 - 1)} above $${low52.toFixed(2)}`,
      weight: 15,
    });
  }
  if (low26 > 0) {
    factors.push({
      label: "≥10% off 26-week low",
      ok: spot / low26 - 1 >= 0.1,
      detail: `${pct(spot / low26 - 1)} above $${low26.toFixed(2)}`,
      weight: 10,
    });
  }

  // Drawdown from 52-week high — deep drawdowns are recovery bets.
  const high52 = Math.max(...closes.slice(-252), spot);
  if (high52 > 0) {
    const dd = 1 - spot / high52;
    factors.push({
      label: "Drawdown < 30% from 52w high",
      ok: dd < 0.3,
      detail: `${pct(dd)} below $${high52.toFixed(2)}`,
      weight: 5,
    });
  }

  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  if (totalWeight === 0) return null;
  const raw = factors.reduce((s, f) => s + (f.ok ? f.weight : 0), 0);
  const score = Math.round((raw / totalWeight) * 100);

  return { score, grade: letter(score), factors };
}
