import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/store/auth";
import type { HistoryTrade, Snapshot, Trade } from "@/types";

// ---- Closed-trade history ----------------------------------------------------

export function useHistoryTrades(portfolioId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["history_trades", portfolioId],
    enabled: !!user && !!portfolioId,
    queryFn: async (): Promise<HistoryTrade[]> => {
      const { data, error } = await supabase
        .from("history_trades")
        .select("*")
        .eq("portfolio_id", portfolioId!)
        .order("exit_date", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Archive a trade to history, then delete it from active trades. */
export function useArchiveTrade() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({
      trade,
      realizedPnl,
      maxLoss,
      value,
    }: {
      trade: Trade;
      realizedPnl: number;
      maxLoss: number;
      value: number;
    }) => {
      const { error: insErr } = await supabase.from("history_trades").insert({
        user_id: user!.id,
        portfolio_id: trade.portfolio_id,
        ticker: trade.ticker,
        trade_type: trade.trade_type,
        entry_date: trade.opened_at,
        exit_date: new Date().toISOString(),
        realized_pnl: realizedPnl,
        iv_at_close: trade.iv,
        max_loss: Number.isFinite(maxLoss) ? maxLoss : 0,
        final_value: value,
      });
      if (insErr) throw insErr;
      const { error: delErr } = await supabase
        .from("trades")
        .delete()
        .eq("id", trade.id);
      if (delErr) throw delErr;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["trades", vars.trade.portfolio_id] });
      qc.invalidateQueries({ queryKey: ["history_trades", vars.trade.portfolio_id] });
    },
  });
}

// ---- Daily snapshots ---------------------------------------------------------

export function useSnapshots(portfolioId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["snapshots", portfolioId],
    enabled: !!user && !!portfolioId,
    queryFn: async (): Promise<Snapshot[]> => {
      const { data, error } = await supabase
        .from("history_snapshots")
        .select("*")
        .eq("portfolio_id", portfolioId!)
        .order("ts", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export interface SnapshotInput {
  portfolio_id: string;
  net_liquidity: number;
  weighted_delta: number;
  expected_profit_total: number;
  erpa: number;
}

/** Upsert one snapshot per portfolio per day (standardized to 16:00). */
export function useRecordSnapshot() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: SnapshotInput) => {
      const now = new Date();
      now.setUTCHours(16, 0, 0, 0);
      // Check existing snapshot for today to avoid duplicates.
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(now);
      dayEnd.setUTCHours(23, 59, 59, 999);

      const { data: existing } = await supabase
        .from("history_snapshots")
        .select("id")
        .eq("portfolio_id", input.portfolio_id)
        .gte("ts", dayStart.toISOString())
        .lte("ts", dayEnd.toISOString());

      if (existing && existing.length > 0) return { skipped: true };

      const { error } = await supabase.from("history_snapshots").insert({
        ...input,
        user_id: user!.id,
        ts: now.toISOString(),
      });
      if (error) throw error;
      return { skipped: false };
    },
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["snapshots", vars.portfolio_id] }),
  });
}
