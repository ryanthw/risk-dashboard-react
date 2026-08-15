import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import {
  REPORT_AREA,
  REPORT_COLORS,
  REPORT_THEME_NAME,
  reportCategoryAxis,
  reportUsd,
  reportValueAxis,
} from "@/components/charts/reportTheme";
import { TRADE_TYPE_LABELS, type TradeType, type Snapshot } from "@/types";
import type { MonthlyPnl } from "@/engine/reportMetrics";
import type { StrategyRecord } from "@/engine/trackRecord";

/**
 * Every chart on the sheet renders SVG under the light report theme. Canvas
 * would rasterize into the PDF at screen resolution; SVG stays vector, so the
 * printed page is as sharp as the type beside it.
 */
const REPORT_CHART = { theme: REPORT_THEME_NAME, renderer: "svg" as const };

const usdTip = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------

/** Net liquidity across the reporting window. */
export function ReportEquityCurve({
  snapshots,
  height = 210,
}: {
  snapshots: Snapshot[];
  height?: number;
}) {
  const option = useMemo<EChartsOption>(
    () => ({
      grid: { left: 4, right: 12, top: 12, bottom: 4, containLabel: true },
      xAxis: { ...reportCategoryAxis(), type: "time" as const },
      yAxis: {
        ...reportValueAxis(reportUsd),
        // A P&L curve on a small account spends its life in a narrow band; a
        // zero-based axis would flatten every move in the period into a line.
        scale: true,
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line" },
        valueFormatter: (v: unknown) => usdTip(Number(v)),
      },
      series: [
        {
          type: "line",
          name: "Net Liquidity",
          // Discrete daily observations — a spline would draw values that were
          // never recorded.
          smooth: false,
          symbol: "circle",
          symbolSize: 4,
          showSymbol: snapshots.length <= 40,
          data: snapshots.map((s) => [s.ts, s.net_liquidity] as [string, number]),
          lineStyle: { color: REPORT_COLORS.series, width: 1.8 },
          itemStyle: { color: REPORT_COLORS.series },
          areaStyle: { color: REPORT_AREA },
        },
      ],
    }),
    [snapshots],
  );

  return <EChart height={height} option={option} {...REPORT_CHART} />;
}

// ---------------------------------------------------------------------------

/** Realized P&L per strategy, signed and sorted. */
export function StrategyPnlBars({
  records,
  height,
}: {
  records: StrategyRecord[];
  height?: number;
}) {
  const rows = useMemo(
    () => [...records].sort((a, b) => a.totalRealized - b.totalRealized),
    [records],
  );

  const option = useMemo<EChartsOption>(
    () => ({
      grid: { left: 4, right: 40, top: 8, bottom: 4, containLabel: true },
      xAxis: { ...reportValueAxis(reportUsd), splitLine: { show: true } },
      yAxis: {
        ...reportCategoryAxis(),
        data: rows.map((r) => TRADE_TYPE_LABELS[r.tradeType as TradeType] ?? r.tradeType),
      },
      tooltip: {
        trigger: "item",
        formatter: (p: unknown) => {
          const { dataIndex } = p as { dataIndex: number };
          const r = rows[dataIndex];
          const label = TRADE_TYPE_LABELS[r.tradeType as TradeType] ?? r.tradeType;
          return `${label}<br/>${usdTip(r.totalRealized)} · ${r.count} trade${
            r.count === 1 ? "" : "s"
          } · ${r.winRate.toFixed(0)}% win`;
        },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 14,
          data: rows.map((r) => ({
            value: r.totalRealized,
            itemStyle: {
              color: r.totalRealized >= 0 ? REPORT_COLORS.gain : REPORT_COLORS.loss,
              // Round only the data end; the baseline end stays square so the
              // bar reads as anchored to zero.
              borderRadius:
                r.totalRealized >= 0
                  ? ([0, 3, 3, 0] as [number, number, number, number])
                  : ([3, 0, 0, 3] as [number, number, number, number]),
            },
          })),
          label: {
            show: true,
            position: "right",
            // Widened to `unknown`: ECharts types a data value as a union
            // including undefined, and a narrower parameter fails strict
            // contravariance against LabelFormatterCallback.
            formatter: (p: { value: unknown }) => usdTip(Number(p.value)),
            fontSize: 9.5,
            color: REPORT_COLORS.text,
          },
        },
      ],
    }),
    [rows],
  );

  // One row is ~22px; the chart grows with the data instead of squashing it.
  const h = height ?? Math.max(120, rows.length * 24 + 24);
  return <EChart height={h} option={option} {...REPORT_CHART} />;
}

// ---------------------------------------------------------------------------

/** Realized P&L bucketed by exit month. */
export function MonthlyPnlBars({
  months,
  height = 170,
}: {
  months: MonthlyPnl[];
  height?: number;
}) {
  const option = useMemo<EChartsOption>(
    () => ({
      grid: { left: 4, right: 12, top: 20, bottom: 4, containLabel: true },
      xAxis: { ...reportCategoryAxis(), data: months.map((m) => m.label) },
      yAxis: { ...reportValueAxis(reportUsd), splitLine: { show: true } },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (p: unknown) => {
          const arr = p as { dataIndex: number }[];
          const m = months[arr[0]?.dataIndex ?? 0];
          return `${m.label}<br/>${usdTip(m.pnl)} · ${m.count} closed`;
        },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 36,
          data: months.map((m) => ({
            value: m.pnl,
            itemStyle: {
              color: m.pnl >= 0 ? REPORT_COLORS.gain : REPORT_COLORS.loss,
              borderRadius:
                m.pnl >= 0
                  ? ([3, 3, 0, 0] as [number, number, number, number])
                  : ([0, 0, 3, 3] as [number, number, number, number]),
            },
          })),
          label: {
            show: true,
            // Values sit outside the bar on the side it points, so a label
            // never lands on top of its own fill.
            position: "top",
            formatter: (p: { value: unknown }) => {
              const v = Number(p.value);
              // Months with no closes are real zeros worth showing as a gap in
              // the bars, but a "$0" label on every one of them is noise.
              return v === 0 ? "" : usdTip(v);
            },
            fontSize: 9.5,
            color: REPORT_COLORS.text,
          },
        },
      ],
    }),
    [months],
  );

  return <EChart height={height} option={option} {...REPORT_CHART} />;
}
