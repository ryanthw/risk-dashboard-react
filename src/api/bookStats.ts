import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/store/auth";
import type { BookStat } from "@/types";

/**
 * Research output for one portfolio: what its own closed trades say about it.
 *
 * Read-only by design — `research_book_stats` is populated from the private
 * research repo and this app holds a select-only policy on it. See the
 * "Research boundary" section of the README.
 *
 * Scoped to a single portfolio on the server rather than filtered in the
 * client: a portfolio is the in-practice boundary of a strategy, and the books
 * are deliberately doing different things, so a figure spanning two of them
 * describes neither.
 */
export function useBookStats(portfolioId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["research_book_stats", portfolioId],
    enabled: !!user && !!portfolioId,
    // Research recomputes these once a day, after the close.
    staleTime: 15 * 60 * 1000,
    queryFn: async (): Promise<BookStat[]> => {
      const { data, error } = await supabase
        .from("research_book_stats")
        .select("*")
        .eq("portfolio_id", portfolioId!);
      if (error) throw error;
      return (data ?? []).map(mapStat);
    },
  });
}

// PostgREST returns `numeric` as a string. Coerce every numeric column, keeping
// null distinct from 0 throughout: null means "not recorded", and for most of
// these columns it means "not recordable for trades archived before 0011".
const NUM: (keyof BookStat)[] = [
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

function mapStat(row: Record<string, unknown>): BookStat {
  const out = { ...(row as unknown as BookStat) };
  for (const k of NUM) {
    const v = row[k as string];
    (out as Record<string, unknown>)[k as string] =
      v == null ? null : Number(v);
  }
  return out;
}
