import { useLocation } from "react-router-dom";
import { Plus, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AddTradeDialog } from "@/components/trades/AddTradeDialog";
import { usePortfolios } from "@/api/portfolios";
import { useTrades } from "@/api/trades";
import { usePortfolioStore } from "@/store/portfolio";
import { useRefreshMarketData } from "@/hooks/useRefreshMarketData";

// Must cover every route in App.tsx — an unmapped path silently falls back to
// "Dashboard", which is how four pages ended up mislabelled.
const TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/visuals": "Visual Analysis",
  "/strategy": "PM Strategy & Allocation",
  "/history": "Historical Analysis",
  "/analysis": "Trade Analysis Sandbox",
  "/position-analysis": "Position Analysis",
  "/scanner": "Earnings Premium Scanner",
  "/income-scanner": "Income Scanner",
  "/basis": "Basis Tracker",
  "/iv-surface": "IV Surface",
  "/reports": "Reports",
};

export function TopBar() {
  const { pathname } = useLocation();
  const { activePortfolioId } = usePortfolioStore();
  const { data: portfolios } = usePortfolios();
  const { data: trades } = useTrades(activePortfolioId);
  const active = portfolios?.find((p) => p.id === activePortfolioId);
  const { refresh, refreshing } = useRefreshMarketData(active, trades ?? []);

  return (
    <header className="no-print sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/80 px-6 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="truncate text-lg font-semibold tracking-tight">
          {TITLES[pathname] ?? "Dashboard"}
        </h1>
        {active && <Badge variant="default">{active.name}</Badge>}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={refreshing || !active}
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh
        </Button>
        {activePortfolioId && (
          <AddTradeDialog
            portfolioId={activePortfolioId}
            trigger={
              <Button size="sm">
                <Plus className="h-4 w-4" /> Add Trade
              </Button>
            }
          />
        )}
      </div>
    </header>
  );
}
