import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionTitle, LoadingState, NoPortfolio } from "@/components/ui/states";
import { useActivePortfolio } from "@/hooks/useActivePortfolio";
import { IncomeScannerPanel } from "@/components/income/IncomeScannerPanel";

export default function IncomeScanner() {
  const { portfolioId, positions, isLoading } = useActivePortfolio();

  // Sector risk weights from the active book — drives the diversification rating
  // so suggestions complement (rather than double up on) current exposure.
  const sectorWeights = useMemo(() => {
    const bySector: Record<string, number> = {};
    let total = 0;
    for (const { trade, metrics } of positions) {
      const risk = Number.isFinite(metrics.maxLoss) ? metrics.maxLoss : 0;
      bySector[trade.sector] = (bySector[trade.sector] ?? 0) + risk;
      total += risk;
    }
    return Object.fromEntries(
      Object.entries(bySector).map(([s, risk]) => [s, total > 0 ? risk / total : 0]),
    );
  }, [positions]);

  if (!portfolioId) return <NoPortfolio />;
  if (isLoading) return <LoadingState />;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <Card>
        <CardContent className="pt-5">
          <SectionTitle>Income Driver — Cash-Secured Put Scanner</SectionTitle>
          <p className="mb-4 text-xs text-muted-foreground">
            Sweeps a curated universe of liquid, low-priced names for cash-secured-put
            income. Ranked by vol-risk premium (IV/HV) × annualized return on collateral ×
            how much each name diversifies your current sector exposure. Names with earnings
            before expiration are excluded.
          </p>
          <IncomeScannerPanel sectorWeights={sectorWeights} />
        </CardContent>
      </Card>
    </div>
  );
}
