/**
 * Realized track record from archived trades.
 *
 * This is the most trustworthy performance data in the app: every figure comes
 * from a closed position with a booked P&L, so unlike the snapshot equity curve
 * it is immune to both irregular sampling and untracked deposits.
 */
import type { HistoryTrade, TradeType } from "@/types";

const MS_PER_DAY = 86_400_000;

export interface TrackRecord {
  count: number;
  wins: number;
  losses: number;
  /** % of closed trades with positive P&L. */
  winRate: number;
  totalRealized: number;
  /** Gross wins / gross losses. null when there are no losses to divide by. */
  profitFactor: number | null;
  avgWin: number;
  avgLoss: number;
  /** Mean P&L per closed trade — win rate and payoff size combined. */
  expectancy: number;
  /** Mean days from entry to exit, over trades that carry both dates. */
  avgHoldDays: number | null;
  /**
   * Realized P&L as a % of the capital that was at risk to earn it. Trades with
   * a non-finite or zero max loss are excluded, so this can cover fewer trades
   * than `count`.
   */
  returnOnRisk: number | null;
  returnOnRiskCount: number;
  /**
   * Closed rows whose P&L could not be determined (stock disposed with no
   * recorded basis). Excluded from every figure above — averaging an unknown
   * result as zero would quietly pull expectancy toward it.
   */
  unbooked: number;
}

const EMPTY: TrackRecord = {
  count: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  totalRealized: 0,
  profitFactor: null,
  avgWin: 0,
  avgLoss: 0,
  expectancy: 0,
  avgHoldDays: null,
  returnOnRisk: null,
  returnOnRiskCount: 0,
  unbooked: 0,
};

export function trackRecord(all: HistoryTrade[]): TrackRecord {
  // A null P&L is an unknown result, not a zero one, so it is held out of every
  // statistic and reported separately.
  const unbooked = all.filter((t) => t.realized_pnl == null).length;
  const trades = all.filter((t) => t.realized_pnl != null);
  if (trades.length === 0) return { ...EMPTY, unbooked };

  let grossWin = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let holdSum = 0;
  let holdCount = 0;
  let riskSum = 0;
  let riskPnl = 0;
  let riskCount = 0;

  for (const t of trades) {
    const pnl = t.realized_pnl as number;
    // Scratches (exactly zero) count as neither a win nor a loss, so they drag
    // expectancy without inflating either side of the payoff ratio.
    if (pnl > 0) {
      wins++;
      grossWin += pnl;
    } else if (pnl < 0) {
      losses++;
      grossLoss += -pnl;
    }

    if (t.entry_date && t.exit_date) {
      const days = (new Date(t.exit_date).getTime() - new Date(t.entry_date).getTime()) / MS_PER_DAY;
      if (Number.isFinite(days) && days >= 0) {
        holdSum += days;
        holdCount++;
      }
    }

    const risk = Math.abs(t.max_loss ?? 0);
    if (Number.isFinite(risk) && risk > 0) {
      riskSum += risk;
      riskPnl += pnl;
      riskCount++;
    }
  }

  const count = trades.length;
  return {
    count,
    wins,
    losses,
    winRate: (wins / count) * 100,
    totalRealized: grossWin - grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgWin: wins > 0 ? grossWin / wins : 0,
    avgLoss: losses > 0 ? grossLoss / losses : 0,
    expectancy: (grossWin - grossLoss) / count,
    avgHoldDays: holdCount > 0 ? holdSum / holdCount : null,
    returnOnRisk: riskSum > 0 ? (riskPnl / riskSum) * 100 : null,
    returnOnRiskCount: riskCount,
    unbooked,
  };
}

export interface StrategyRecord extends TrackRecord {
  tradeType: TradeType;
}

/** Track record split by strategy, best expectancy first. */
export function trackRecordByStrategy(trades: HistoryTrade[]): StrategyRecord[] {
  const groups = new Map<TradeType, HistoryTrade[]>();
  for (const t of trades) {
    const key = t.trade_type as TradeType;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  return [...groups.entries()]
    .map(([tradeType, list]) => ({ tradeType, ...trackRecord(list) }))
    .sort((a, b) => b.expectancy - a.expectancy);
}
