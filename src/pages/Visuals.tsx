import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { Card, CardContent } from "@/components/ui/card";
import { Metric } from "@/components/ui/metric";
import { EChart } from "@/components/charts/EChart";
import { CHART_COLORS, CHART_SEQUENCE, mixHex, CHART_SURFACE } from "@/components/charts/theme";
import {
  PNL_DIVERGING,
  X_NAME_GAP,
  axisGrid,
  axisUsd,
  categoryAxis,
  histogram,
  tipUsd,
  valueAxis,
} from "@/components/charts/echartsTheme";
import { EmptyState, LoadingState, NoPortfolio, SectionTitle } from "@/components/ui/states";
import { useActivePortfolio } from "@/hooks/useActivePortfolio";
import { theoreticalValue } from "@/engine/blackScholes";
import { mean, stdDev } from "@/engine/monteCarlo";
import { erAnn } from "@/engine/portfolio";
import { fmtUsd, fmtPct } from "@/lib/format";

/** Deterministic color per ticker for consistent legends. */
function tickerColor(ticker: string, tickers: string[]): string {
  return CHART_SEQUENCE[tickers.indexOf(ticker) % CHART_SEQUENCE.length];
}

export default function Visuals() {
  const { portfolioId, positions, cash, portValue, isLoading } = useActivePortfolio();

  const uniqueTickers = useMemo(
    () => [...new Set(positions.map((p) => p.trade.ticker))],
    [positions],
  );

  // Aggregated options-only P&L distribution (sum element-wise across legs).
  const agg = useMemo(() => {
    const optionDists = positions
      .filter((p) => p.trade.trade_type !== "shares")
      .map((p) => p.metrics.pnlDist);
    if (optionDists.length === 0) return null;
    const n = optionDists[0].length;
    const total = new Float64Array(n);
    for (const d of optionDists) for (let i = 0; i < n; i++) total[i] += d[i];
    const avg = mean(total);
    const sd = stdDev(total);
    let wins = 0;
    for (let i = 0; i < n; i++) if (total[i] > 0) wins++;
    // Downsample for the histogram.
    const sample: number[] = [];
    for (let i = 0; i < n; i += 10) sample.push(total[i]);
    return { avg, sd, pop: (wins / n) * 100, sample };
  }, [positions]);

  // Stress-test matrix: P&L under simultaneous price & vol shocks.
  const stress = useMemo(() => {
    if (positions.length === 0) return null;
    const priceShifts = Array.from({ length: 14 }, (_, i) => -0.15 + (0.3 * i) / 13);
    const volShifts = Array.from({ length: 10 }, (_, i) => -0.1 + (0.4 * i) / 9);
    const z = volShifts.map((vS) =>
      priceShifts.map((pS) => {
        let pnl = 0;
        for (const { trade, metrics } of positions) {
          const S = trade.underlying_price ?? 0;
          const T = metrics.dte / 365;
          const v0 = theoreticalValue(trade, S, T, trade.iv);
          const vShock = theoreticalValue(trade, S * (1 + pS), T, trade.iv + vS);
          pnl += vShock - v0;
        }
        return pnl;
      }),
    );
    const maxAbs = Math.max(1, ...z.flat().map((v) => Math.abs(v)));
    return {
      z,
      maxAbs,
      x: priceShifts.map((p) => `${(p * 100).toFixed(0)}%`),
      y: volShifts.map((v) => `${(v * 100).toFixed(0)}%`),
    };
  }, [positions]);

  // Greek decay over the next 30 days.
  const decay = useMemo(() => {
    const opts = positions.filter((p) => p.trade.trade_type !== "shares");
    if (opts.length === 0) return null;
    const days = Array.from({ length: 31 }, (_, i) => i);
    const theta: number[] = [];
    const vega: number[] = [];
    for (const d of days) {
      let tTheta = 0;
      let tVega = 0;
      for (const { trade, metrics } of opts) {
        const S = trade.underlying_price ?? 0;
        const Tnew = Math.max(0, (metrics.dte - d) / 365);
        const v0 = theoreticalValue(trade, S, Tnew, trade.iv);
        const vUp = theoreticalValue(trade, S, Tnew, trade.iv + 0.01);
        tVega += (vUp - v0) / (0.01 * 100);
        const vNext = theoreticalValue(trade, S, Math.max(0, Tnew - 1 / 365), trade.iv);
        tTheta += vNext - v0;
      }
      theta.push(tTheta);
      vega.push(tVega);
    }
    return { days, theta, vega };
  }, [positions]);

  // 10-year wealth forecast from annualized expected return.
  const forecast = useMemo(() => {
    const rate = erAnn(positions, cash);
    if (!rate || portValue <= 0) return null;
    const years = Array.from({ length: 11 }, (_, i) => i);
    return {
      rate,
      years,
      target: years.map((y) => portValue * (1 + rate) ** y),
      conservative: years.map((y) => portValue * (1 + rate * 0.7) ** y),
    };
  }, [positions, cash, portValue]);

  // ---- Chart options -------------------------------------------------------
  // Built above the early returns so they stay inside the hook order.

  const riskRewardOption = useMemo<EChartsOption>(
    () => ({
      grid: axisGrid(),
      xAxis: { ...valueAxis("Max Loss ($)", axisUsd), nameGap: X_NAME_GAP },
      yAxis: valueAxis("Max Gain ($)", axisUsd),
      tooltip: {
        trigger: "item",
        formatter: (p: unknown) => {
          const { data } = p as { data: { name: string; value: [number, number, number] } };
          return `<b>${data.name}</b><br/>Max Loss ${tipUsd(data.value[0])}<br/>Max Gain ${tipUsd(
            data.value[1],
          )}`;
        },
      },
      series: [
        {
          type: "scatter",
          symbolSize: (v: number[]) => v[2],
          data: positions.map((p) => ({
            name: p.trade.ticker,
            value: [p.metrics.maxLoss, p.metrics.maxGain, 8 + p.metrics.pop * 26],
            itemStyle: {
              color: tickerColor(p.trade.ticker, uniqueTickers),
              opacity: 0.85,
              // Softer than the old hard white outline — separates overlapping
              // bubbles without ringing every marker.
              borderColor: "rgba(255,255,255,0.10)",
              borderWidth: 1,
            },
          })),
          emphasis: { focus: "self", itemStyle: { opacity: 1, borderWidth: 2 } },
        },
      ],
    }),
    [positions, uniqueTickers],
  );

  const expirationOption = useMemo<EChartsOption>(() => {
    const optionLegs = positions.filter((p) => p.trade.trade_type !== "shares");
    // Soonest expiration on the left (ISO dates sort chronologically).
    const expirations = [
      ...new Set(optionLegs.map((p) => p.trade.expiration ?? "")),
    ].sort();
    return {
      grid: axisGrid({ legend: true }),
      // Scroll rather than wrap: a wrapped legend silently eats plot height.
      legend: { type: "scroll", top: 0, left: 0, itemWidth: 10, itemHeight: 10 },
      xAxis: { ...categoryAxis("Expiration"), data: expirations },
      yAxis: valueAxis("Max Loss ($)", axisUsd),
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        // Every ticker is a series, so an axis-triggered tooltip lists all of
        // them at every expiration — including the majority sitting at $0.
        // Only the ones actually carrying risk here are worth showing.
        formatter: (params: unknown) => {
          const all = params as Array<{
            marker: string;
            seriesName: string;
            value: number;
            axisValueLabel: string;
          }>;
          const rows = all.filter((p) => Number(p.value) > 0);
          if (rows.length === 0) return "";
          const total = rows.reduce((a, p) => a + Number(p.value), 0);
          const body = rows
            .map(
              (p) =>
                `<div style="display:flex;justify-content:space-between;gap:18px">` +
                `<span>${p.marker}${p.seriesName}</span>` +
                `<span style="font-weight:600">${tipUsd(Number(p.value))}</span></div>`,
            )
            .join("");
          const totalRow =
            rows.length > 1
              ? `<div style="display:flex;justify-content:space-between;gap:18px;` +
                `margin-top:5px;padding-top:5px;border-top:1px solid rgba(148,163,184,0.22)">` +
                `<span style="opacity:0.75">Total</span>` +
                `<span style="font-weight:600">${tipUsd(total)}</span></div>`
              : "";
          return `<div style="margin-bottom:4px;opacity:0.75">${rows[0].axisValueLabel}</div>${body}${totalRow}`;
        },
      },
      series: uniqueTickers
        .map((tk) => {
          const legs = optionLegs.filter((p) => p.trade.ticker === tk);
          if (legs.length === 0) return null;
          const byExp = new Map(
            legs.map((p) => [p.trade.expiration ?? "", Math.abs(p.metrics.maxLoss)]),
          );
          return {
            type: "bar" as const,
            name: tk,
            // Stacked, not grouped: most tickers hold legs at a single
            // expiration, so grouping split each band N ways and left the
            // occupied bars hairline-thin. One column per expiry reads as
            // total risk expiring then, segmented by ticker.
            stack: "risk",
            data: expirations.map((e) => byExp.get(e) ?? 0),
            barCategoryGap: "42%",
            barMaxWidth: 56,
            itemStyle: { color: tickerColor(tk, uniqueTickers) },
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null),
    };
  }, [positions, uniqueTickers]);

  const allocationOption = useMemo<EChartsOption>(() => {
    const values = positions.map((p) => Math.abs(p.metrics.maxLoss));
    const total = values.reduce((a, b) => a + b, 0);
    // Label visibility is decided per slice rather than by hiding overlapping
    // labels after layout: `labelLayout.hideOverlap` drops the text but leaves
    // the leader line behind, which reads as a rendering glitch. Turning both
    // off together on thin slices keeps the ring clean.
    const pieSlices = positions.map((p, i) => {
      const value = values[i];
      const show = total > 0 && (value / total) * 100 >= 5;
      return {
        name: p.trade.ticker,
        value,
        itemStyle: { color: CHART_SEQUENCE[i % CHART_SEQUENCE.length] },
        label: { show },
        labelLine: { show },
      };
    });
    return {
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      // No legend: with a long tail of sub-1% tickers it wrapped over the ring.
      // Small slices are identified on hover instead.
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
          // Kept modest so outside labels have room; at 74% the longer ticker
          // labels ran into the card edge and ellipsised.
          radius: ["38%", "58%"],
          center: ["50%", "50%"],
          avoidLabelOverlap: true,
          padAngle: 1.5,
          itemStyle: { borderRadius: 4, borderColor: CHART_SURFACE, borderWidth: 2 },
          label: {
            color: CHART_COLORS.text,
            fontSize: 11,
            formatter: "{b}\n{d}%",
            lineHeight: 14,
          },
          labelLine: { length: 8, length2: 8, lineStyle: { color: CHART_COLORS.grid } },
          data: pieSlices,
        },
      ],
    };
  }, [positions]);

  const pnlDistOption = useMemo<EChartsOption>(() => {
    if (!agg) return {};
    const { centers, counts } = histogram(agg.sample);
    return {
      grid: axisGrid(),
      xAxis: { ...valueAxis("P&L at Expiration ($)", axisUsd), nameGap: X_NAME_GAP },
      yAxis: valueAxis("Frequency"),
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line" },
        formatter: (p: unknown) => {
          const arr = p as Array<{ value: [number, number] }>;
          if (!arr.length) return "";
          return `P&L ${tipUsd(arr[0].value[0])}<br/>${arr[0].value[1]} paths`;
        },
      },
      series: [
        {
          type: "bar",
          barWidth: "99%",
          data: centers.map((c, i) => [c, counts[i]]),
          itemStyle: { color: CHART_COLORS.brand, opacity: 0.85 },
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: CHART_COLORS.loss, width: 2, type: "dashed" },
            data: [{ xAxis: 0 }],
          },
        },
      ],
    };
  }, [agg]);

  const stressOption = useMemo<EChartsOption>(() => {
    if (!stress) return {};
    const data: [number, number, number][] = [];
    stress.z.forEach((row, yi) => row.forEach((v, xi) => data.push([xi, yi, v])));
    return {
      grid: axisGrid({ right: 86 }),
      xAxis: { ...categoryAxis("Price Shift"), data: stress.x, splitArea: { show: false } },
      yAxis: { ...categoryAxis("Vol Shift"), data: stress.y, nameGap: 44 },
      tooltip: {
        trigger: "item",
        formatter: (p: unknown) => {
          const d = p as { value: [number, number, number] };
          return `Price ${stress.x[d.value[0]]}<br/>Vol ${stress.y[d.value[1]]}<br/>P&L ${tipUsd(
            d.value[2],
          )}`;
        },
      },
      visualMap: {
        type: "continuous",
        min: -stress.maxAbs,
        max: stress.maxAbs,
        calculable: true,
        // Vertical on the right, matching the colorbar this replaced. The
        // horizontal variant rendered as an oversized slab across the plot.
        orient: "vertical",
        right: 8,
        top: "middle",
        itemWidth: 12,
        itemHeight: 150,
        text: ["gain", "loss"],
        textStyle: { color: CHART_COLORS.muted, fontSize: 10 },
        // App-native diverging ramp, replacing Plotly's stock RdYlGn.
        inRange: { color: PNL_DIVERGING },
      },
      series: [
        {
          type: "heatmap",
          data,
          itemStyle: { borderColor: CHART_SURFACE, borderWidth: 1 },
          emphasis: { itemStyle: { borderColor: CHART_COLORS.text, borderWidth: 1.5 } },
        },
      ],
    };
  }, [stress]);

  const decayOption = useMemo<EChartsOption>(() => {
    if (!decay) return {};
    return {
      grid: axisGrid({ legend: true }),
      legend: { top: 0, left: 0 },
      xAxis: { ...categoryAxis("Days from Now"), data: decay.days, boundaryGap: false },
      yAxis: valueAxis("Risk Exposure ($)", axisUsd),
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        valueFormatter: (v: unknown) => tipUsd(Number(v)),
      },
      series: [
        {
          type: "line",
          name: "Total Theta",
          data: decay.theta,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: CHART_COLORS.gain, width: 2.5 },
          itemStyle: { color: CHART_COLORS.gain },
        },
        {
          type: "line",
          name: "Total Vega",
          data: decay.vega,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: CHART_COLORS.violet, width: 2.5 },
          itemStyle: { color: CHART_COLORS.violet },
        },
      ],
    };
  }, [decay]);

  const forecastOption = useMemo<EChartsOption>(() => {
    if (!forecast) return {};
    return {
      grid: axisGrid({ legend: true }),
      legend: { top: 0, left: 0 },
      xAxis: { ...categoryAxis("Year"), data: forecast.years, boundaryGap: false },
      yAxis: valueAxis("Account Balance ($)", axisUsd),
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        valueFormatter: (v: unknown) => tipUsd(Number(v)),
      },
      series: [
        {
          type: "line",
          name: `Target (${(forecast.rate * 100).toFixed(1)}% APR)`,
          data: forecast.target,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: CHART_COLORS.gain, width: 2.5 },
          itemStyle: { color: CHART_COLORS.gain },
          areaStyle: {
            color: mixHex(CHART_COLORS.gain, CHART_SURFACE, 0.72),
            opacity: 0.5,
          },
        },
        {
          type: "line",
          name: "Conservative (70%)",
          data: forecast.conservative,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: CHART_COLORS.brand, width: 2, type: "dashed" },
          itemStyle: { color: CHART_COLORS.brand },
        },
      ],
    };
  }, [forecast]);

  if (!portfolioId) return <NoPortfolio />;
  if (isLoading) return <LoadingState />;
  if (positions.length === 0)
    return (
      <EmptyState title="No trades to visualize" hint="Add positions on the Dashboard." />
    );

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardContent className="pt-5">
            <SectionTitle>Risk-Reward Profile</SectionTitle>
            <EChart height={300} option={riskRewardOption} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <SectionTitle>Capital at Risk by Expiration</SectionTitle>
            <EChart height={300} option={expirationOption} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <SectionTitle>Risk Allocation</SectionTitle>
            <EChart height={300} option={allocationOption} />
          </CardContent>
        </Card>
      </div>

      {agg && (
        <Card>
          <CardContent className="pt-5">
            <SectionTitle>Aggregated P&L Distribution (Monte Carlo)</SectionTitle>
            <div className="mb-4 grid grid-cols-3 gap-4">
              <Metric label="Agg. Expected Return" value={fmtUsd(agg.avg)} accent="primary" />
              <Metric label="Portfolio Std Dev" value={fmtUsd(agg.sd)} />
              <Metric label="Portfolio POP" value={fmtPct(agg.pop, 1)} accent="gain" />
            </div>
            <EChart height={340} option={pnlDistOption} />
            <p className="mt-2 text-xs text-muted-foreground">
              Options-only view — share positions are excluded due to their long horizon
              and skew.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {stress && (
          <Card>
            <CardContent className="pt-5">
              <SectionTitle>Stress-Test Matrix</SectionTitle>
              <EChart height={340} option={stressOption} />
              <p className="mt-2 text-xs text-muted-foreground">
                Estimated P&L under simultaneous price and volatility shocks.
              </p>
            </CardContent>
          </Card>
        )}

        {decay && (
          <Card>
            <CardContent className="pt-5">
              <SectionTitle>Greek Decay (30 Days)</SectionTitle>
              <EChart height={340} option={decayOption} />
              <p className="mt-2 text-xs text-muted-foreground">
                How portfolio Theta income and Vega risk evolve as expirations approach.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {forecast && (
        <Card>
          <CardContent className="pt-5">
            <SectionTitle>10-Year Wealth Forecast</SectionTitle>
            <EChart height={340} option={forecastOption} />
            <p className="mt-2 text-xs text-muted-foreground">
              Target assumes full reinvestment at the annualized expected return.
              Conservative realizes 70% of that.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
