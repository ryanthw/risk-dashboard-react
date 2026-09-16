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
import type { ExitPath, HistoryTrade, IvSource, Snapshot, Trade } from "@/types";

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
      if (delta) await applySharesDelta(trade, delta, user!.id, exit.path);

      // The whole position, not just its result. The `trades` row is deleted
      // four lines below, so anything not copied here stops existing — and
      // strike, premium, qty and the exit path are what any later analysis of
      // *why* a trade worked has to join on. Realized P&L alone can't tell a
      // short put that expired worthless from one bought back at a loss and
      // re-sold, and can't express a return on the capital actually at risk.
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

        qty: trade.qty,
        strike: trade.strike,
        strike_2: trade.strike_2,
        premium: trade.premium,
        expiration: trade.expiration,
        cost_basis: trade.cost_basis,
        iv_at_open: trade.iv_at_open,
        atm_iv_at_open: trade.atm_iv_at_open,
        underlying_at_open: trade.underlying_at_open,
        // Current spot: refreshPortfolio keeps underlying_price marked, so at
        // the moment of archiving it is the price at close.
        underlying_at_close: trade.underlying_price,
        sector: trade.sector,
        beta: trade.beta,
        exit_path: exit.path,
        iv_source: trade.iv_source,
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

interface ShareLot {
  id: string;
  qty: number;
  cost_basis: number | null;
  opened_at: string;
  iv: number;
  iv_at_open: number | null;
  underlying_at_open: number | null;
  iv_source: IvSource | null;
  sector: string | null;
  beta: number | null;
}

/**
 * Add or remove the stock an assignment/call-away moves.
 *
 * Acquiring merges into the oldest lot at a blended basis rather than opening a
 * second row, so coverage allocation in the Basis Tracker keeps working.
 *
 * Disposing sells FIFO across lots and archives each sold slice to
 * history_trades with its own realized P&L — proceeds at the strike less that
 * lot's basis. Being called away above your basis *is* a gain, and it belongs
 * to the shares, not to the call (whose result is the premium alone).
 */
async function applySharesDelta(
  trade: Trade,
  delta: SharesDelta,
  userId: string,
  exitPath: ExitPath,
) {
  const { data: rows, error } = await supabase
    .from("trades")
    .select("*")
    .eq("portfolio_id", trade.portfolio_id)
    .eq("ticker", trade.ticker)
    .eq("trade_type", "shares")
    // Oldest first: FIFO, so the lot that gets called away is deterministic
    // rather than whatever order PostgREST happened to return.
    .order("opened_at", { ascending: true });
  if (error) throw error;

  const lots = (rows ?? []) as unknown as ShareLot[];

  if (delta.direction === "acquire") {
    const existing = lots[0];
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
        // A new position, so it gets entry stamps like any other. Stock arriving
        // by assignment is acquired at the strike, which is what basisPerShare
        // holds — not the current quote in underlying_price.
        underlying_at_open: delta.basisPerShare,
        iv_at_open: trade.iv,
        iv_source: "entry",
      });
      if (e) throw e;
    }
    return;
  }

  // Nothing to remove — the cover was a LEAPS, not stock.
  if (lots.length === 0) return;

  const strike = delta.basisPerShare;
  let toSell = delta.shares;

  for (const lot of lots) {
    if (toSell <= 0) break;
    const lotQty = Number(lot.qty);
    const sold = Math.min(toSell, lotQty);
    const basis = lot.cost_basis == null ? null : Number(lot.cost_basis);

    // Basis unknown means the P&L is genuinely unknown. Record the disposal
    // with a null result rather than inventing one from the current mark.
    const pnl = basis == null ? null : (strike - basis) * sold;

    const { error: insErr } = await supabase.from("history_trades").insert({
      user_id: userId,
      portfolio_id: trade.portfolio_id,
      ticker: trade.ticker,
      trade_type: "shares",
      entry_date: lot.opened_at,
      exit_date: new Date().toISOString(),
      realized_pnl: pnl,
      iv_at_close: lot.iv,
      // Capital that was at risk on the sold slice: stock can go to zero.
      max_loss: basis == null ? 0 : basis * sold,
      final_value: strike * sold,

      // Only the slice that actually left, not the whole lot.
      qty: sold,
      cost_basis: basis,
      iv_at_open: lot.iv_at_open,
      underlying_at_open: lot.underlying_at_open,
      // Stock disposed by an option exit leaves at the strike, by definition.
      underlying_at_close: strike,
      sector: lot.sector,
      beta: lot.beta,
      // Inherited from the option whose exit moved the stock: the shares did
      // not end on their own terms, they were called away or put to the book.
      exit_path: exitPath,
      iv_source: lot.iv_source,
    });
    if (insErr) throw insErr;

    const remaining = lotQty - sold;
    if (remaining > 0) {
      const { error: e } = await supabase
        .from("trades")
        .update({ qty: remaining })
        .eq("id", lot.id);
      if (e) throw e;
    } else {
      const { error: e } = await supabase.from("trades").delete().eq("id", lot.id);
      if (e) throw e;
    }
    toSell -= sold;
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

// Snapshots are written by lib/refreshPortfolio, which both the app and the
// scheduled job call. There is deliberately no second writer here: the previous
// one kept its own copy of the one-per-day and timestamp logic, and the two
// could drift apart silently.
