import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/store/auth";
import { invalidateCash, recordCashFlow } from "./cashFlows";
import type { Portfolio } from "@/types";

const KEY = "portfolios";

export function usePortfolios() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [KEY, user?.id],
    enabled: !!user,
    queryFn: async (): Promise<Portfolio[]> => {
      const { data, error } = await supabase
        .from("portfolios")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map((p) => ({ ...p, cash: Number(p.cash) }));
    },
  });
}

export function useCreatePortfolio() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (name: string): Promise<Portfolio> => {
      const { data, error } = await supabase
        .from("portfolios")
        .insert({ user_id: user!.id, name: name.trim(), cash: 0 })
        .select()
        .single();
      if (error) throw error;
      return { ...data, cash: Number(data.cash) };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useDeletePortfolio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("portfolios").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] });
      qc.invalidateQueries({ queryKey: ["trades"] });
    },
  });
}

/**
 * Corrects the balance to an absolute figure by booking the difference as an
 * `adjustment`. Writing portfolios.cash directly would leave the ledger unable
 * to explain how the balance got where it is, so even a manual correction goes
 * through record_cash_flow. Adjustments are internal, so they do not register
 * as a contribution in TWR — use a deposit/withdrawal for real transfers.
 */
export function useUpdateCash() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      cash,
      currentCash,
    }: {
      id: string;
      cash: number;
      currentCash: number;
    }) => {
      const delta = cash - currentCash;
      if (delta === 0) return;
      await recordCashFlow({
        portfolio_id: id,
        amount: delta,
        kind: "adjustment",
        note: `Balance corrected to ${cash}`,
      });
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: [KEY] });
      invalidateCash(qc, vars.id);
    },
  });
}
