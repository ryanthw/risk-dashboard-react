import { useMemo } from "react";
import { usePortfolios } from "@/api/portfolios";
import { usePositions } from "./usePositions";
import { usePortfolioStore } from "@/store/portfolio";
import { portfolioValue } from "@/engine/portfolio";

/** Convenience hook: active portfolio + its positions + cached portfolio value. */
export function useActivePortfolio() {
  const { activePortfolioId } = usePortfolioStore();
  const { data: portfolios, isLoading: loadingPortfolios } = usePortfolios();
  const { positions, trades, isLoading: loadingTrades, refetch } =
    usePositions(activePortfolioId);

  const portfolio = portfolios?.find((p) => p.id === activePortfolioId);
  const cash = portfolio?.cash ?? 0;
  const portValue = useMemo(
    () => portfolioValue(positions, cash),
    [positions, cash],
  );

  return {
    portfolioId: activePortfolioId,
    portfolio,
    positions,
    trades,
    cash,
    portValue,
    isLoading: loadingPortfolios || loadingTrades,
    refetch,
  };
}
