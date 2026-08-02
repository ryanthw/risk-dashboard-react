import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Metric } from "@/components/ui/metric";
import { Badge } from "@/components/ui/badge";
import { EChart } from "@/components/charts/EChart";
import {
  CHART_COLORS,
  CHART_SEQUENCE,
  CHART_SURFACE,
  mixHex,
  toTileTone,
} from "@/components/charts/theme";
import {
  CORR_DIVERGING,
  categoryAxis,
  tipUsd,
} from "@/components/charts/echartsTheme";
import { EmptyState, LoadingState, NoPortfolio, SectionTitle } from "@/components/ui/states";
import { useActivePortfolio } from "@/hooks/useActivePortfolio";
import { betaWeightedDelta } from "@/engine/portfolio";
import { fetchBatchCloses, correlationMatrix } from "@/api/marketData";
import { isSupabaseConfigured } from "@/lib/supabase";
import { fmtUsd, fmtPct, fmtNum } from "@/lib/format";
import { TRADE_TYPE_LABELS, type TradeType } from "@/types";

export default function Strategy() {
  const { portfolioId, positions, isLoading } = useActivePortfolio();

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

  // ECharts takes the hierarchy natively, so no parallel label/parent arrays.
  const treemapOption = useMemo<EChartsOption>(() => {
    const sectors = Object.keys(agg.bySector);

    // Each sector gets a palette hue; its tickers get progressively deeper
    // shades of that same hue, so a child is visibly distinct from its parent
    // while still reading as belonging to it.
    const children = sectors.map((sector, i) => {
      const tone = toTileTone(CHART_SEQUENCE[i % CHART_SEQUENCE.length]);
      const own = Object.keys(agg.byTicker).filter((t) => agg.byTicker[t].sector === sector);
      return {
        name: sector,
        // borderColor too: a parent's fill is only visible as the header strip
        // and the gutter around its children, and both are drawn with the
        // *border*. Leaving it at the surface color rendered every sector black.
        itemStyle: { color: tone, borderColor: tone },
        children: own.map((t, idx) => ({
          name: t,
          value: agg.byTicker[t].risk,
          // Steps of 0.16 keep adjacent shades ~15 sRGB levels apart — visibly
          // distinct — while the cap stops deep sectors fading into the page.
          itemStyle: { color: mixHex(tone, CHART_SURFACE, Math.min(0.18 + idx * 0.16, 0.7)) },
        })),
      };
    });

    return {
      tooltip: {
        trigger: "item",
        formatter: (p: unknown) => {
          const d = p as { name: string; value: number };
          return `<b>${d.name}</b><br/>${tipUsd(d.value)}`;
        },
      },
      series: [
        {
          type: "treemap",
          data: children,
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          // Two levels only; without this ECharts collapses to the top level.
          leafDepth: 2,
          // Explicit insets rather than width/height 100% — the latter is
          // combined with ECharts' default centering and left the map floating
          // with dead space above and the last row clipped.
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          itemStyle: { borderColor: CHART_SURFACE, borderWidth: 2, gapWidth: 2 },
          label: { color: CHART_COLORS.text, fontSize: 11, formatter: "{b}" },
          upperLabel: {
            show: true,
            height: 20,
            color: CHART_COLORS.text,
            fontSize: 11,
          },
          levels: [
            // No borderColor at the sector level — it must fall through to each
            // node's own tone so the headers read as distinct colors.
            { itemStyle: { borderWidth: 3, gapWidth: 3 } },
            { itemStyle: { borderWidth: 1, borderColor: CHART_SURFACE, gapWidth: 1 } },
          ],
        },
      ],
    };
  }, [agg]);

  const strategyPieOption = useMemo<EChartsOption>(() => {
    const entries = Object.entries(agg.byStrategy);
    const total = entries.reduce((a, [, v]) => a + v, 0);
    return {
      legend: { show: false },
      tooltip: {
        trigger: "item",
        formatter: (p: unknown) => {
          const d = p as { name: string; value: number; percent: number };
          return `<b>${d.name}</b><br/>${tipUsd(d.value)} · ${d.percent.toFixed(1)}%`;
        },
      },
      series: [
        {
          type: "pie",
          radius: ["40%", "60%"],
          center: ["50%", "50%"],
          avoidLabelOverlap: true,
          padAngle: 1.5,
          itemStyle: { borderRadius: 4, borderColor: CHART_SURFACE, borderWidth: 2 },
          label: { color: CHART_COLORS.text, fontSize: 11, formatter: "{b}\n{d}%", lineHeight: 14 },
          labelLine: { length: 8, length2: 8, lineStyle: { color: CHART_COLORS.grid } },
          data: entries.map(([type, value], i) => {
            // Same rule as the Visuals donut: hide label and leader line
            // together on slices too thin to carry text.
            const show = total > 0 && (value / total) * 100 >= 5;
            return {
              name: TRADE_TYPE_LABELS[type as TradeType],
              value,
              itemStyle: { color: CHART_SEQUENCE[i % CHART_SEQUENCE.length] },
              label: { show },
              labelLine: { show },
            };
          }),
        },
      ],
    };
  }, [agg]);

  const corrOption = useMemo<EChartsOption | null>(() => {
    const corr = corrQuery.data;
    if (!corr || corr.tickers.length < 2) return null;
    const data: [number, number, number][] = [];
    corr.matrix.forEach((row, yi) =>
      row.forEach((v, xi) => data.push([xi, yi, +v.toFixed(4)])),
    );
    return {
      grid: { left: 56, right: 72, top: 12, bottom: 56, containLabel: true },
      xAxis: { ...categoryAxis(), data: corr.tickers },
      yAxis: { ...categoryAxis(), data: corr.tickers },
      tooltip: {
        trigger: "item",
        formatter: (p: unknown) => {
          const d = p as { value: [number, number, number] };
          return `${corr.tickers[d.value[0]]} / ${corr.tickers[d.value[1]]}<br/>ρ = ${d.value[2].toFixed(2)}`;
        },
      },
      visualMap: {
        type: "continuous",
        min: -1,
        max: 1,
        calculable: true,
        orient: "vertical",
        right: 4,
        top: "middle",
        itemWidth: 10,
        itemHeight: 150,
        precision: 2,
        textStyle: { color: CHART_COLORS.muted, fontSize: 10 },
        inRange: { color: CORR_DIVERGING },
      },
      series: [
        {
          type: "heatmap",
          data,
          itemStyle: { borderColor: CHART_SURFACE, borderWidth: 2 },
          emphasis: { itemStyle: { borderColor: CHART_COLORS.text, borderWidth: 1.5 } },
        },
      ],
    };
  }, [corrQuery.data]);

  if (!portfolioId) return <NoPortfolio />;
  if (isLoading) return <LoadingState />;
  if (positions.length === 0)
    return <EmptyState title="No positions" hint="Add trades to see PM analytics." />;

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
          <EChart height={340} option={treemapOption} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Capital by strategy */}
        {/* h-fit stops the grid stretching this card to match the taller
            allocation guard beside it, which left the fixed-height donut
            floating in a pool of dead space. */}
        <Card className="h-fit">
          <CardContent className="pt-5">
            <SectionTitle>Capital by Strategy</SectionTitle>
            <EChart height={320} option={strategyPieOption} />
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
          ) : corrOption && corrQuery.data ? (
            <>
              <EChart
                height={Math.max(320, corrQuery.data.tickers.length * 36)}
                option={corrOption}
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
