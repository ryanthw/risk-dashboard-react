/**
 * Row mappers: PostgREST rows into the app's domain types.
 *
 * PostgREST returns `numeric` as a string, so every numeric column has to be
 * coerced on the way in, keeping null distinct from 0 — null means "not
 * recorded", which is not the same claim as zero.
 *
 * Pure on purpose. The app's query hooks and the headless scripts (snapshot,
 * email report) both read these tables, and a second copy of the coercion in a
 * script is how one side ends up multiplying a string.
 */
import type { BookStat, CashFlow, HistoryTrade, Snapshot, Trade } from "@/types";

const num = (v: unknown) => (v == null ? null : Number(v));

export function mapTrade(row: Record<string, unknown>): Trade {
  return {
    ...(row as unknown as Trade),
    qty: Number(row.qty),
    strike: num(row.strike),
    strike_2: num(row.strike_2),
    premium: num(row.premium),
    iv: Number(row.iv),
    underlying_price: num(row.underlying_price),
    cost_basis: num(row.cost_basis),
    beta: Number(row.beta ?? 1),
    iv_at_open: num(row.iv_at_open),
    atm_iv_at_open: num(row.atm_iv_at_open),
    underlying_at_open: num(row.underlying_at_open),
    iv_skew_ratio: num(row.iv_skew_ratio),
  };
}

// Every numeric column of research_book_stats.
const STAT_NUM: (keyof BookStat)[] = [
  "n", "n_full", "n_pnl", "n_wins", "win_rate", "total_pnl", "mean_pnl",
  "median_pnl", "best_pnl", "worst_pnl", "profit_factor", "expectancy",
  "n_ror", "mean_ror", "median_ror", "mean_ann_ror", "n_return_on_premium",
  "mean_return_on_premium", "mean_pct_max_gain_captured", "mean_hold_days",
  "median_hold_days", "n_dte", "mean_dte_at_entry", "mean_dte_held_pct",
  "n_moneyness", "mean_moneyness_at_entry", "n_premium_yield",
  "mean_premium_yield_ann", "n_iv", "mean_iv_at_open", "mean_iv_vs_atm_at_open",
  "mean_iv_change_pct", "n_exit_path", "rate_expired", "rate_assigned",
  "rate_called_away", "rate_closed_early", "n_itm", "rate_finished_itm",
  "rate_move_favored", "mean_underlying_move_pct",
];

export function mapBookStat(row: Record<string, unknown>): BookStat {
  const out = { ...(row as unknown as BookStat) };
  for (const k of STAT_NUM) {
    (out as Record<string, unknown>)[k as string] = num(row[k as string]);
  }
  return out;
}

export function mapSnapshot(row: Record<string, unknown>): Snapshot {
  return {
    ...(row as unknown as Snapshot),
    net_liquidity: Number(row.net_liquidity),
    weighted_delta: Number(row.weighted_delta),
    expected_profit_total: Number(row.expected_profit_total),
    erpa: Number(row.erpa),
  };
}

export function mapCashFlow(row: Record<string, unknown>): CashFlow {
  return { ...(row as unknown as CashFlow), amount: Number(row.amount) };
}

export function mapHistoryTrade(row: Record<string, unknown>): HistoryTrade {
  return {
    ...(row as unknown as HistoryTrade),
    realized_pnl: num(row.realized_pnl),
    max_loss: Number(row.max_loss),
    final_value: Number(row.final_value),
    iv_at_close: Number(row.iv_at_close),
    qty: num(row.qty),
    strike: num(row.strike),
    strike_2: num(row.strike_2),
    premium: num(row.premium),
    cost_basis: num(row.cost_basis),
  };
}
