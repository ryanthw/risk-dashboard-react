import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/store/auth";
import { invalidateCash, recordCashFlow } from "./cashFlows";
import {
  EXIT_PATH_LABELS,
  closingCashFlow,
  exitFlowKind,
  realizedPnl,
  sharesDelta,
  type ExitInput,
  type SharesDelta,
} from "@/engine/cashFlow";
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

/**
 * Archive a trade to history: book the exit's cash, apply any stock the exit
 * delivers or removes, write the history row, then drop the active trade.
 *
 * Cash is booked from the closing *transaction*, never from realized P&L —
 * P&L is derived from the opening and closing pair. See engine/cashFlow.
 */
export function useArchiveTrade() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({
      trade,
      exit,
      maxLoss,
      value,
    }: {
      trade: Trade;
      exit: ExitInput;
      maxLoss: number;
      value: number;
    }) => {
      const pnl = realizedPnl(trade, exit);
      const closeFlow = closingCashFlow(trade, exit);

      if (closeFlow !== 0) {
        await recordCashFlow({
          portfolio_id: trade.portfolio_id,
          amount: closeFlow,
          kind: exitFlowKind(exit.path),
          trade_id: trade.id,
          ticker: trade.ticker,
          note: `${EXIT_PATH_LABELS[exit.path]} ${trade.trade_type} ${trade.ticker}`,
        });
      }

      // Assignment delivers stock; call-away takes it. Reflect that in the
      // position list so the book matches reality without manual fixing up.
      const delta = sharesDelta(trade, exit.path);
      if (delta) await applySharesDelta(trade, delta, user!.id);

      const { error: insErr } = await supabase.from("history_trades").insert({
        user_id: user!.id,
        portfolio_id: trade.portfolio_id,
        ticker: trade.ticker,
        trade_type: trade.trade_type,
        entry_date: trade.opened_at,
        exit_date: new Date().toISOString(),
        realized_pnl: pnl,
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

      return { pnl, closeFlow };
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["trades", vars.trade.portfolio_id] });
      qc.invalidateQueries({ queryKey: ["history_trades", vars.trade.portfolio_id] });
      invalidateCash(qc, vars.trade.portfolio_id);
    },
  });
}

/**
 * Add or remove the stock an assignment/call-away moves.
 *
 * Acquiring merges into an existing lot at a blended basis rather than opening
 * a second row, so coverage allocation in the Basis Tracker keeps working.
 * Disposing reduces the lot and deletes it once it is exhausted; the shares'
 * own P&L is left to that position rather than folded into the option's.
 */
async function applySharesDelta(trade: Trade, delta: SharesDelta, userId: string) {
  const { data: rows, error } = await supabase
    .from("trades")
    .select("*")
    .eq("portfolio_id", trade.portfolio_id)
    .eq("ticker", trade.ticker)
    .eq("trade_type", "shares");
  if (error) throw error;

  const existing = (rows ?? [])[0] as
    | { id: string; qty: number; cost_basis: number | null }
    | undefined;

  if (delta.direction === "acquire") {
    if (existing) {
      const oldQty = Number(existing.qty);
      const oldBasis = existing.cost_basis == null ? null : Number(existing.cost_basis);
      const newQty = oldQty + delta.shares;
      // Blend only when the old basis is known; otherwise leave it null so the
      // Basis Tracker keeps flagging it as missing instead of inventing one.
      const blended =
        oldBasis == null
          ? null
          : (oldBasis * oldQty + delta.basisPerShare * delta.shares) / newQty;
      const { error: e } = await supabase
        .from("trades")
        .update({ qty: newQty, cost_basis: blended })
        .eq("id", existing.id);
      if (e) throw e;
    } else {
      const { error: e } = await supabase.from("trades").insert({
        user_id: userId,
        portfolio_id: trade.portfolio_id,
        trade_type: "shares",
        ticker: trade.ticker,
        qty: delta.shares,
        cost_basis: delta.basisPerShare,
        underlying_price: trade.underlying_price,
        iv: trade.iv,
        sector: trade.sector,
        beta: trade.beta,
      });
      if (e) throw e;
    }
    return;
  }

  if (!existing) return; // Nothing to remove — the cover was a LEAPS, not stock.
  const remaining = Number(existing.qty) - delta.shares;
  if (remaining > 0) {
    const { error: e } = await supabase
      .from("trades")
      .update({ qty: remaining })
      .eq("id", existing.id);
    if (e) throw e;
  } else {
    const { error: e } = await supabase.from("trades").delete().eq("id", existing.id);
    if (e) throw e;
  }
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
