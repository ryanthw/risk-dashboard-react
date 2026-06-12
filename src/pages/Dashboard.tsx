import { useMemo } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Metric, StatRow } from "@/components/ui/metric";
import { EmptyState, LoadingState, NoPortfolio, SectionTitle } from "@/components/ui/states";
import { TradeCard } from "@/components/trades/TradeCard";
import { AddTradeDialog } from "@/components/trades/AddTradeDialog";
import { useActivePortfolio } from "@/hooks/useActivePortfolio";
import { fmtUsd, fmtNum, fmtPct, fmtMultiple } from "@/lib/format";
import * as P from "@/engine/portfolio";

// S&P benchmarks for alpha multipliers (from the original Dashboard.py).
const SPY_LT = 7.5; // annual %
const SPY_ST = ((1 + 0.075) ** (1 / 26) - 1) * 100; // ~bi-weekly %

export default function Dashboard() {
  const { portfolioId, positions, cash, portValue, isLoading } = useActivePortfolio();

  const stats = useMemo(() => {
    if (positions.length === 0) return null;
    const erAnn = P.erAnn(positions, cash) * 100;
    const erPct = P.erPercent(positions, cash);
    return {
      gross: P.grossExposure(positions),
      netLiq: P.netLiquidity(positions, cash),
      hhi: P.hhi(positions),
      pctExposure: P.percentExposure(positions, cash),
      leverage: P.leverageRatio(positions, cash),
      cashToPos: P.cashToPosRatio(positions, cash),
      highestPos: P.highestPosPercent(positions, cash),
      expReturns: P.expectedReturns(positions),
      maxProfit: P.maxProfit(positions),
      riskReward: P.riskRewardRatio(positions),
      cashPct: P.cashPercent(positions, cash),
      erAnn,
      erPct,
      ltAlpha: erAnn / SPY_LT,
      stAlpha: erPct / SPY_ST,
    };
  }, [positions, cash]);

  if (!portfolioId) return <NoPortfolio />;
  if (isLoading) return <LoadingState label="Loading portfolio…" />;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* Big-5 metrics */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Metric label="Total Value" value={fmtUsd(portValue)} accent="primary" />
        <Metric label="Gross Exposure" value={fmtUsd(stats?.gross ?? 0)} />
        <Metric label="Net Liquidity" value={fmtUsd(stats?.netLiq ?? 0)} />
        <Metric label="HHI (Concentration)" value={fmtNum(stats?.hhi ?? 0)} />
        <Metric label="Open Trades" value={positions.length} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* Risk Analysis */}
        <div className="lg:col-span-3">
          <SectionTitle>Risk Analysis</SectionTitle>
          {stats ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardContent className="space-y-2 pt-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Exposure & Leverage
                  </p>
                  <StatRow label="Percent Exposure" value={fmtPct(stats.pctExposure)} />
                  <StatRow label="Leverage Ratio" value={fmtMultiple(stats.leverage)} />
                  <StatRow label="Cash / Position" value={fmtNum(stats.cashToPos)} />
                  <StatRow label="Highest Position" value={fmtPct(stats.highestPos)} />
                  <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Performance Multipliers
                  </p>
                  <StatRow
                    label="LT Alpha (vs SPY)"
                    value={fmtMultiple(stats.ltAlpha)}
                    tone="gain"
                  />
                  <StatRow
                    label="ST Alpha (vs SPY)"
                    value={fmtMultiple(stats.stAlpha)}
                    tone="gain"
                  />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-2 pt-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Returns & Profitability
                  </p>
                  <StatRow label="Expected Returns" value={fmtUsd(stats.expReturns)} />
                  <StatRow label="ERP (% of value)" value={fmtPct(stats.erPct)} />
                  <StatRow label="ERPA (annualized)" value={fmtPct(stats.erAnn)} />
                  <StatRow label="Max Gain" value={fmtUsd(stats.maxProfit)} />
                  <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Efficiency
                  </p>
                  <StatRow label="Risk / Reward" value={fmtNum(stats.riskReward)} />
                  <StatRow label="Cash Percent" value={fmtPct(stats.cashPct)} />
                </CardContent>
              </Card>
            </div>
          ) : (
            <Card>
              <CardContent className="pt-5">
                <p className="text-sm text-muted-foreground">
                  Add positions to compute risk analytics.
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Open Trades */}
        <div className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <SectionTitle>Open Trades</SectionTitle>
            <AddTradeDialog
              portfolioId={portfolioId}
              trigger={
                <Button variant="ghost" size="sm">
                  <Plus className="h-4 w-4" /> Add
                </Button>
              }
            />
          </div>
          {positions.length === 0 ? (
            <EmptyState
              title="No open trades"
              hint="Add your first position to begin tracking risk."
            />
          ) : (
            <div className="max-h-[640px] space-y-3 overflow-y-auto scrollbar-thin pr-1">
              {positions.map((pos) => (
                <TradeCard key={pos.trade.id} position={pos} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
