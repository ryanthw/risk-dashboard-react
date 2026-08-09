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
