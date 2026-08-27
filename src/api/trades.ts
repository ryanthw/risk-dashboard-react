import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/store/auth";
import {
  adjustTradeOpenCash,
  deleteTradeCash,
  invalidateCash,
  recordCashFlow,
} from "./cashFlows";
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
      // restate this same row through useUpdateTrade, and booking a second one
      // here would double-count.
      //
      // Booked even when the amount is zero. The row is what marks this trade's
      // opening cash as ledger-managed, so that a later edit — filling in a
      // premium that was left at 0, say — knows it may restate it. Trades from
      // before the ledger existed have no such row and are left alone.
      if (isCreate) {
        await recordCashFlow({
          portfolio_id: trade.portfolio_id,
          amount: openingCashFlow(trade),
          kind: "trade_open",
          trade_id: trade.id,
          ticker: trade.ticker,
          note: `Opened ${trade.trade_type} ${trade.ticker}`,
          // Stamped when the position was opened, not when it was typed in, so
          // a backdated entry lands in the ledger where it actually belongs.
          ts: trade.opened_at,
        });
      }
      return trade;
    },
    onSuccess: (t, vars) => {
      qc.invalidateQueries({ queryKey: [KEY, t.portfolio_id] });
      if (!vars.id) invalidateCash(qc, t.portfolio_id);
    },
  });
}

export type TradePatch = Partial<Trade> & {
  id: string;
  portfolio_id: string;
  /** The trade as it stood before the edit, to price the correction against. */
  previous: Trade;
};

/**
 * Edit a position and restate the cash it booked at open.
 *
 * Editing qty, premium, cost basis or the open date changes what actually
 * changed hands, so the opening flow is corrected in place rather than a
 * reversal being appended: a mis-entry is not an event in the portfolio's life,
 * and a corrected trade should look like it was entered right the first time.
 *
 * The correction is the *difference* the edit makes, not the new entry cost —
 * see adjustTradeOpenCash for why a shares lot makes those two different
 * numbers. An edit that leaves the entry cost alone moves no cash.
 */
export function useUpdateTrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      patch: TradePatch,
    ): Promise<{ trade: Trade; cashDelta: number }> => {
      const { id, portfolio_id: _p, previous, ...fields } = patch;
      const { data, error } = await supabase
        .from("trades")
        .update(fields)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      const trade = mapTrade(data);

      const delta = openingCashFlow(trade) - openingCashFlow(previous);
      const moved = trade.opened_at !== previous.opened_at;
      const cashDelta =
        delta === 0 && !moved
          ? 0
          : await adjustTradeOpenCash({
              trade_id: trade.id,
              portfolio_id: trade.portfolio_id,
              delta,
              // The flow is stamped when the position was opened, so a re-dated
              // entry takes its cash with it.
              ts: moved ? trade.opened_at : null,
            });

      return { trade, cashDelta };
    },
    onSuccess: ({ trade }) => {
      qc.invalidateQueries({ queryKey: [KEY, trade.portfolio_id] });
      // Unconditional: re-dating an entry moves its ledger row even when the
      // amount is untouched.
      invalidateCash(qc, trade.portfolio_id);
    },
  });
}

/**
 * Hard delete: remove the position and everything it booked.
 *
 * This is the "it should never have existed" path — no history row, no realized
 * result — so the opening cash comes back out and the trade leaves no trace in
 * any portfolio figure. A real exit goes through useArchiveTrade instead.
 *
 * Cash first: the FK nulls cash_flows.trade_id when the trade goes, which would
 * strand the rows with no way to find them. Unwinding is a no-op the second
 * time, so a failed trade delete can simply be retried.
 */
export function useDeleteTrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      portfolioId,
    }: {
      id: string;
      portfolioId: string;
    }): Promise<number> => {
      const reversed = await deleteTradeCash(id, portfolioId);
      const { error } = await supabase.from("trades").delete().eq("id", id);
      if (error) throw error;
      return reversed;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: [KEY, vars.portfolioId] });
      invalidateCash(qc, vars.portfolioId);
    },
  });
}
