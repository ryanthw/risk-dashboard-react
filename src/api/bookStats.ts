import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/store/auth";
import { mapBookStat } from "@/lib/rows";
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
      // numeric arrives as a string; null stays null — for most of these
      // columns it means "not recordable for trades archived before 0011".
      return (data ?? []).map(mapBookStat);
    },
  });
}
