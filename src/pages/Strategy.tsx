import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Metric } from "@/components/ui/metric";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Chart } from "@/components/charts/Chart";
import { CHART_SEQUENCE } from "@/components/charts/theme";
import { EmptyState, LoadingState, NoPortfolio, SectionTitle } from "@/components/ui/states";
import { useActivePortfolio } from "@/hooks/useActivePortfolio";
import { betaWeightedDelta, undeployedCash } from "@/engine/portfolio";
import { fetchBatchCloses, correlationMatrix } from "@/api/marketData";
import { isSupabaseConfigured } from "@/lib/supabase";
import { fmtUsd, fmtPct, fmtNum } from "@/lib/format";
import { TRADE_TYPE_LABELS, type TradeType } from "@/types";

const CORE_TICKERS = ["SCHD", "VIG", "ORC", "MAIN", "AGNC", "ARCC"];
const TARGETS = {
  dividend: 0.125,
  spy: 0.125,
  driver: 0.6,
  spreads: 0.1,
  cash: 0.05,
};

function FulfillmentRow({
  label,
  actual,
  target,
  portVal,
}: {
  label: string;
  actual: number;
  target: number;
  portVal: number;
}) {
  const pct = portVal > 0 ? actual / portVal : 0;
  const progress = Math.min((pct / target) * 100, 100);
  const delta = (pct - target) * 100;
  return (
    <div className="grid grid-cols-[1fr_2fr_auto] items-center gap-3">
      <span className="text-sm font-medium">{label}</span>
      <Progress value={progress} />
      <span className="w-28 text-right text-sm tnum">
        {fmtPct(pct * 100, 1)}{" "}
        <span className={delta >= 0 ? "text-gain" : "text-loss"}>
          ({delta >= 0 ? "+" : ""}
          {delta.toFixed(1)})
        </span>
      </span>
    </div>
  );
}

export default function Strategy() {
  const { portfolioId, positions, cash, portValue, isLoading } = useActivePortfolio();

  const uniqueTickers = useMemo(
    () => [...new Set(positions.map((p) => p.trade.ticker))],
    [positions],
  );

  // Risk aggregated by ticker / sector / strategy.
  const agg = useMemo(() => {
    const byTicker: Record<string, { risk: number; sector: string }> = {};
    const bySector: Record<string, number> = {};
    const byStrategy: Record<string, number> = {};
    for (const { trade, metrics } of positions) {
      const risk = Number.isFinite(metrics.maxLoss) ? metrics.maxLoss : 0;
      byTicker[trade.ticker] = {
        risk: (byTicker[trade.ticker]?.risk ?? 0) + risk,
        sector: trade.sector,
      };
      bySector[trade.sector] = (bySector[trade.sector] ?? 0) + risk;
      byStrategy[trade.trade_type] = (byStrategy[trade.trade_type] ?? 0) + risk;
    }
    const totalRisk = Object.values(byTicker).reduce((a, b) => a + b.risk, 0);
    return { byTicker, bySector, byStrategy, totalRisk };
  }, [positions]);

  // Income-factory bucket risks.
  const buckets = useMemo(() => {
    const sum = (pred: (t: { trade_type: TradeType; ticker: string }) => boolean) =>
      positions
        .filter((p) => pred(p.trade))
        .reduce((a, p) => a + (Number.isFinite(p.metrics.maxLoss) ? p.metrics.maxLoss : 0), 0);
    return {
      dividend: sum((t) => t.trade_type === "shares" && CORE_TICKERS.includes(t.ticker)),
      spy: sum((t) => t.trade_type === "shares" && t.ticker === "SPY"),
      driver: sum(
        (t) =>
          ["csp", "cc", "short_put", "short_call"].includes(t.trade_type) ||
          (t.trade_type === "shares" &&
            !CORE_TICKERS.includes(t.ticker) &&
            t.ticker !== "SPY"),
      ),
      spreads: sum((t) => ["pcs", "ccs", "cds", "pds"].includes(t.trade_type)),
      cash: undeployedCash(positions, cash),
    };
  }, [positions, cash]);

  // Vitals: beta-delta + estimated daily theta.
  const betaDelta = useMemo(() => betaWeightedDelta(positions), [positions]);
  const estTheta = useMemo(
    () =>
      positions
        .filter((p) => p.trade.trade_type !== "shares")
        .reduce((a, p) => a + p.metrics.expectedProfit / Math.max(p.metrics.dte, 1), 0),
    [positions],
  );

  // Correlation matrix from live market data.
  const corrQuery = useQuery({
    queryKey: ["correlation", uniqueTickers],
    enabled: isSupabaseConfigured && uniqueTickers.length > 1,
    staleTime: 1000 * 60 * 30,
    queryFn: async () => {
      const closes = await fetchBatchCloses(uniqueTickers, 180);
      return correlationMatrix(closes);
    },
  });

  const antiCorr = useMemo(() => {
    const corr = corrQuery.data;
    if (!corr || corr.tickers.length < 2) return null;
    const weights: Record<string, number> = {};
    for (const t of corr.tickers) {
      weights[t] = agg.totalRisk > 0 ? (agg.byTicker[t]?.risk ?? 0) / agg.totalRisk : 0;
    }
    let wcs = 0;
    let wps = 0;
    const flags: { pair: string; corr: number }[] = [];
    for (let i = 0; i < corr.tickers.length; i++) {
      for (let j = i + 1; j < corr.tickers.length; j++) {
        const t1 = corr.tickers[i];
        const t2 = corr.tickers[j];
        const c = corr.matrix[i][j];
        const w = weights[t1] * weights[t2];
        wcs += c * w;
        wps += w;
        if (c > 0.75) flags.push({ pair: `${t1} / ${t2}`, corr: c });
      }
    }
    const avg = wps > 0 ? wcs / wps : 0;
    return { score: 1 - avg, flags };
  }, [corrQuery.data, agg]);

  if (!portfolioId) return <NoPortfolio />;
  if (isLoading) return <LoadingState />;
  if (positions.length === 0)
    return <EmptyState title="No positions" hint="Add trades to see PM analytics." />;

  const sectors = Object.keys(agg.bySector);
  const tickers = Object.keys(agg.byTicker);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* Vitals */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Metric
          label="Anti-Correlation Score"
          value={antiCorr ? fmtNum(antiCorr.score) : "—"}
          hint="Diversification (goal > 0.60)"
          accent={antiCorr && antiCorr.score > 0.6 ? "gain" : "default"}
        />
        <Metric
          label="Beta-Weighted Delta"
          value={fmtNum(betaDelta, 1)}
          hint={betaDelta > 0 ? "Bullish bias" : "Bearish bias"}
        />
        <Metric label="Daily Income (Est. Theta)" value={fmtUsd(estTheta)} accent="gain" />
      </div>

      {/* Treemap */}
      <Card>
        <CardContent className="pt-5">
          <SectionTitle>Capital Allocation by Sector</SectionTitle>
          <Chart
            height={340}
            data={[
              {
                type: "treemap",
                branchvalues: "total",
                labels: [...sectors, ...tickers],
                parents: [...sectors.map(() => ""), ...tickers.map((t) => agg.byTicker[t].sector)],
                values: [
                  ...sectors.map((s) => agg.bySector[s]),
                  ...tickers.map((t) => agg.byTicker[t].risk),
                ],
                marker: { colors: CHART_SEQUENCE },
                textinfo: "label+value",
                hovertemplate: "<b>%{label}</b><br>$%{value:,.0f}<extra></extra>",
              },
            ]}
            layout={{ margin: { l: 8, r: 8, t: 8, b: 8 } }}
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Capital by strategy */}
        <Card>
          <CardContent className="pt-5">
            <SectionTitle>Capital by Strategy</SectionTitle>
            <Chart
              height={320}
              data={[
                {
                  type: "pie",
                  hole: 0.5,
                  labels: Object.keys(agg.byStrategy).map(
                    (t) => TRADE_TYPE_LABELS[t as TradeType],
                  ),
                  values: Object.values(agg.byStrategy),
                  marker: { colors: CHART_SEQUENCE },
                  textinfo: "label+percent",
                  textfont: { size: 11 },
                },
              ]}
              layout={{ showlegend: false }}
            />
          </CardContent>
        </Card>

        {/* Ticker allocation guard */}
        <Card>
          <CardContent className="pt-5">
            <SectionTitle>Ticker Allocation Guard</SectionTitle>
            <div className="space-y-1.5">
              {tickers
                .map((t) => ({
                  ticker: t,
                  risk: agg.byTicker[t].risk,
                  pct: agg.totalRisk > 0 ? (agg.byTicker[t].risk / agg.totalRisk) * 100 : 0,
                }))
                .sort((a, b) => b.pct - a.pct)
                .map((row) => (
                  <div
                    key={row.ticker}
                    className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{row.ticker}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground tnum">{fmtUsd(row.risk)}</span>
                      <span
                        className={`w-14 text-right font-semibold tnum ${row.pct > 10 ? "text-loss" : "text-gain"}`}
                      >
                        {fmtPct(row.pct, 1)}
                      </span>
                    </div>
                  </div>
                ))}
            </div>
            {tickers.some((t) => (agg.byTicker[t].risk / agg.totalRisk) * 100 > 10) ? (
              <Badge variant="loss" className="mt-3">
                Concentration alert: ticker &gt; 10%
              </Badge>
            ) : (
              <Badge variant="gain" className="mt-3">
                Diversification within 10% limit
              </Badge>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Income factory fulfillment */}
      <Card>
        <CardContent className="space-y-3 pt-5">
          <SectionTitle>Income Factory Fulfillment</SectionTitle>
          <FulfillmentRow label="Dividend Engine" actual={buckets.dividend} target={TARGETS.dividend} portVal={portValue} />
          <FulfillmentRow label="S&P 500 Core" actual={buckets.spy} target={TARGETS.spy} portVal={portValue} />
          <FulfillmentRow label="Income Driver" actual={buckets.driver} target={TARGETS.driver} portVal={portValue} />
          <FulfillmentRow label="Credit Spreads" actual={buckets.spreads} target={TARGETS.spreads} portVal={portValue} />
          <FulfillmentRow label="Cash / Hedges" actual={buckets.cash} target={TARGETS.cash} portVal={portValue} />
        </CardContent>
      </Card>

      {/* Correlation */}
      <Card>
        <CardContent className="pt-5">
          <SectionTitle>Anti-Correlation Analysis</SectionTitle>
          {!isSupabaseConfigured ? (
            <EmptyState title="Market data not configured" hint="Add Supabase keys to compute correlations." />
          ) : uniqueTickers.length < 2 ? (
            <EmptyState title="Need at least two tickers" hint="Add more positions to analyze correlation." />
          ) : corrQuery.isLoading ? (
            <LoadingState label="Fetching price history…" />
          ) : corrQuery.data && corrQuery.data.tickers.length > 1 ? (
            <>
              <Chart
                height={Math.max(320, corrQuery.data.tickers.length * 36)}
                data={[
                  {
                    type: "heatmap",
                    z: corrQuery.data.matrix,
                    x: corrQuery.data.tickers,
                    y: corrQuery.data.tickers,
                    colorscale: "RdBu",
                    reversescale: true,
                    zmin: -1,
                    zmax: 1,
                    colorbar: { thickness: 12 },
                    hovertemplate: "%{x} / %{y}<br>ρ = %{z:.2f}<extra></extra>",
                  },
                ]}
                layout={{ xaxis: { type: "category" }, yaxis: { type: "category" } }}
              />
              {antiCorr && antiCorr.flags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {antiCorr.flags.map((f) => (
                    <Badge key={f.pair} variant="loss">
                      {f.pair}: ρ {f.corr.toFixed(2)}
                    </Badge>
                  ))}
                </div>
              )}
            </>
          ) : (
            <EmptyState title="Correlation unavailable" hint="Could not load enough price history." />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
