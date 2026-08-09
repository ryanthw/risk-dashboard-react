import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/store/auth";
import { invalidateCash, recordCashFlow } from "./cashFlows";
import { openingCashFlow } from "@/engine/cashFlow";
import type { Trade, TradeInput } from "@/types";

const KEY = "trades";

function mapTrade(row: Record<string, unknown>): Trade {
  return {
    ...(row as unknown as Trade),
    qty: Number(row.qty),
    strike: row.strike == null ? null : Number(row.strike),
    strike_2: row.strike_2 == null ? null : Number(row.strike_2),
    premium: row.premium == null ? null : Number(row.premium),
    iv: Number(row.iv),
    underlying_price: row.underlying_price == null ? null : Number(row.underlying_price),
    cost_basis: row.cost_basis == null ? null : Number(row.cost_basis),
    beta: Number(row.beta ?? 1),
  };
}

export function useTrades(portfolioId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: [KEY, portfolioId],
    enabled: !!user && !!portfolioId,
    queryFn: async (): Promise<Trade[]> => {
      const { data, error } = await supabase
        .from("trades")
        .select("*")
        .eq("portfolio_id", portfolioId!)
        .order("opened_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(mapTrade);
    },
  });
}

export function useUpsertTrade() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: TradeInput & { id?: string }): Promise<Trade> => {
      const payload = {
        ...input,
        user_id: user!.id,
        sector: input.sector ?? "Unknown",
        beta: input.beta ?? 1.0,
      };
      const isCreate = !input.id;
      const { data, error } = await supabase
        .from("trades")
        .upsert(payload)
        .select()
        .single();
      if (error) throw error;
      const trade = mapTrade(data);

      // Opening a position moves cash: a credit structure pays you the premium,
      // a debit one costs it, shares cost their basis. Only on create — edits
      // go through useUpdateTrade, and re-booking here would double-count.
      if (isCreate) {
        const amount = openingCashFlow(trade);
        if (amount !== 0) {
          await recordCashFlow({
            portfolio_id: trade.portfolio_id,
            amount,
            kind: "trade_open",
            trade_id: trade.id,
            ticker: trade.ticker,
            note: `Opened ${trade.trade_type} ${trade.ticker}`,
          });
        }
      }
      return trade;
    },
    onSuccess: (t, vars) => {
      qc.invalidateQueries({ queryKey: [KEY, t.portfolio_id] });
      if (!vars.id) invalidateCash(qc, t.portfolio_id);
    },
  });
}

export function useUpdateTrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      patch: Partial<Trade> & { id: string; portfolio_id: string },
    ): Promise<Trade> => {
      const { id, portfolio_id: _p, ...fields } = patch;
      const { data, error } = await supabase
        .from("trades")
        .update(fields)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return mapTrade(data);
    },
    onSuccess: (t) => qc.invalidateQueries({ queryKey: [KEY, t.portfolio_id] }),
  });
}

export function useDeleteTrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; portfolioId: string }) => {
      const { error } = await supabase.from("trades").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: [KEY, vars.portfolioId] }),
  });
}
