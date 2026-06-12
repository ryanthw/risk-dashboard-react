import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { fetchQuote } from "@/api/marketData";
import { useRecordSnapshot } from "@/api/history";
import { deriveTradeMetrics } from "@/engine/trade";
import { snapshotMetrics, type Position } from "@/engine/portfolio";
import type { Portfolio, Trade } from "@/types";
import { toast } from "@/components/ui/toast";

/**
 * Refreshes live prices/IV for every unique ticker in a portfolio, persists the
 * updates, then records a daily snapshot. Mirrors utils.update_underlyings +
 * capture_and_save_snapshot.
 */
export function useRefreshMarketData(portfolio: Portfolio | undefined, trades: Trade[]) {
  const [refreshing, setRefreshing] = useState(false);
  const qc = useQueryClient();
  const recordSnapshot = useRecordSnapshot();

  const refresh = async () => {
    if (!portfolio) return;
    setRefreshing(true);
    try {
      // 1. Fetch quotes for unique tickers.
      const tickers = [...new Set(trades.map((t) => t.ticker))];
      const quotes = new Map<string, Awaited<ReturnType<typeof fetchQuote>>>();
      await Promise.all(
        tickers.map(async (tk) => {
          try {
            quotes.set(tk, await fetchQuote(tk));
          } catch {
            /* leave stale on failure */
          }
        }),
      );

      // 2. Persist updated underlyings (and IV for shares).
      const updated: Trade[] = [];
      for (const t of trades) {
        const q = quotes.get(t.ticker);
        if (!q || q.price <= 0) {
          updated.push(t);
          continue;
        }
        const next: Trade = {
          ...t,
          underlying_price: Number(q.price.toFixed(2)),
          iv: t.trade_type === "shares" ? q.hv : t.iv,
          sector: q.sector || t.sector,
          beta: q.beta || t.beta,
        };
        updated.push(next);
        await supabase
          .from("trades")
          .update({
            underlying_price: next.underlying_price,
            iv: next.iv,
            sector: next.sector,
            beta: next.beta,
          })
          .eq("id", t.id);
      }
      await qc.invalidateQueries({ queryKey: ["trades", portfolio.id] });

      // 3. Record snapshot from refreshed positions.
      const positions: Position[] = updated.map((trade) => ({
        trade,
        metrics: deriveTradeMetrics(trade),
      }));
      const metrics = snapshotMetrics(positions, portfolio.cash);
      const res = await recordSnapshot.mutateAsync({
        portfolio_id: portfolio.id,
        ...metrics,
      });

      toast.success(
        "Market data refreshed",
        res?.skipped ? "Snapshot already logged today" : "Snapshot logged",
      );
    } catch (e) {
      toast.error("Refresh failed", String((e as Error).message));
    } finally {
      setRefreshing(false);
    }
  };

  return { refresh, refreshing };
}
