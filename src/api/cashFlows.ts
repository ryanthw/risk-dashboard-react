import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { CashFlow, CashFlowKind } from "@/types";

export function useCashFlows(portfolioId: string | null) {
  return useQuery({
    queryKey: ["cash_flows", portfolioId],
    enabled: !!portfolioId,
    queryFn: async (): Promise<CashFlow[]> => {
      const { data, error } = await supabase
        .from("cash_flows")
        .select("*")
        .eq("portfolio_id", portfolioId!)
        .order("ts", { ascending: true });
      if (error) throw error;
      // numeric comes back as a string over PostgREST.
      return (data ?? []).map((r) => ({ ...r, amount: Number(r.amount) }));
    },
  });
}

export interface RecordFlowInput {
  portfolio_id: string;
  /** Signed: positive moves cash in, negative out. */
  amount: number;
  kind: CashFlowKind;
  trade_id?: string | null;
  ticker?: string | null;
  note?: string | null;
  ts?: string;
}

/**
 * Writes a ledger row and moves portfolios.cash by the same amount.
 *
 * Both happen inside record_cash_flow() so they share a transaction — the
 * ledger and the balance can never disagree. Never update portfolios.cash
 * directly; that is what lets the ledger stay the record of how the balance
 * got where it is.
 */
export async function recordCashFlow(input: RecordFlowInput): Promise<void> {
  const { error } = await supabase.rpc("record_cash_flow", {
    p_portfolio_id: input.portfolio_id,
    p_amount: input.amount,
    p_kind: input.kind,
    p_trade_id: input.trade_id ?? null,
    p_ticker: input.ticker ?? null,
    p_note: input.note ?? null,
    ...(input.ts ? { p_ts: input.ts } : {}),
  });
  if (error) throw error;
}

/** Query keys touched by any cash movement. */
export function invalidateCash(
  qc: ReturnType<typeof useQueryClient>,
  portfolioId: string,
) {
  qc.invalidateQueries({ queryKey: ["cash_flows", portfolioId] });
  qc.invalidateQueries({ queryKey: ["portfolios"] });
}

export function useRecordCashFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: recordCashFlow,
    onSuccess: (_d, vars) => invalidateCash(qc, vars.portfolio_id),
  });
}

/**
 * Remove every ledger row a trade booked and back the same amount out of the
 * balance. Returns the net amount removed.
 *
 * Only for the hard-delete path — "this position was never real". A genuine
 * exit goes through useArchiveTrade, which keeps both flows because the cash
 * actually moved. Nothing is left behind here on purpose: a reversal row would
 * settle the balance while still reading as an event in the portfolio's life.
 *
 * Call before deleting the trade row; the FK nulls trade_id on delete.
 */
export async function deleteTradeCash(
  tradeId: string,
  portfolioId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("delete_trade_cash", {
    p_trade_id: tradeId,
    p_portfolio_id: portfolioId,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

export interface AdjustTradeOpenInput {
  trade_id: string;
  portfolio_id: string;
  /** Change in the trade's entry cost, signed the same way as the flow itself. */
  delta: number;
  /** New timestamp for the flow when the open date moved; null leaves it. */
  ts?: string | null;
}

/**
 * Restate a trade's opening flow in place after an edit. Returns the delta
 * applied to the balance — 0 when the trade's open was never on the ledger.
 *
 * The *change* in entry cost, not the new absolute: a shares lot that absorbed
 * an assignment carries cash booked by the `assignment` flow too, and restating
 * it to basis x qty would count those dollars a second time.
 */
export async function adjustTradeOpenCash(
  input: AdjustTradeOpenInput,
): Promise<number> {
  const { data, error } = await supabase.rpc("adjust_trade_open_cash", {
    p_trade_id: input.trade_id,
    p_portfolio_id: input.portfolio_id,
    p_delta: input.delta,
    p_ts: input.ts ?? null,
  });
  if (error) throw error;
  return Number(data ?? 0);
}
