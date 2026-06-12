import { useMemo } from "react";
import { useTrades } from "@/api/trades";
import { deriveTradeMetrics } from "@/engine/trade";
import type { Position } from "@/engine/portfolio";

/**
 * Loads a portfolio's trades and attaches computed risk metrics to each.
 * Monte-Carlo metrics are recomputed only when the trades data changes
 * (react-query keeps a stable reference between refetches).
 */
export function usePositions(portfolioId: string | null) {
  const { data: trades, isLoading, isError, refetch } = useTrades(portfolioId);

  const positions: Position[] = useMemo(() => {
    if (!trades) return [];
    return trades.map((trade) => ({ trade, metrics: deriveTradeMetrics(trade) }));
  }, [trades]);

  return { positions, trades: trades ?? [], isLoading, isError, refetch };
}
