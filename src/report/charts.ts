/**
 * Charts for the email report, rendered server-side to SVG with ECharts' SSR
 * mode (no DOM). The caller rasterises to PNG: Gmail and most clients do not
 * display SVG, so an email chart has to be an image.
 *
 * Static by nature — an email has no hover — so every series is direct-labelled
 * at its end and the same numbers appear in a table beside the chart.
 */
import * as echarts from "echarts";
import { BENCHMARK } from "./benchmark";
import type { GrowthPoint } from "./portfolioReport";

/**
 * Light-surface counterparts of the dashboard palette (components/charts/
 * theme.ts), validated for an email's white background: the brand blue as-is
 * and the dashboard's amber deepened to clear 3:1. Text never takes a series
 * color; it stays in ink.
 */
export const EMAIL_PALETTE = {
  book: "#1f9bdb",
  benchmark: "#c27c0e",
  ink: "#1f2328",
  muted: "#5b6573",
  grid: "#e6eaef",
  axis: "#c9d1d9",
  surface: "#ffffff",
};

/** Font stack resvg can resolve on both a Windows dev box and an Ubuntu runner. */
export const CHART_FONT = "Inter, 'Segoe UI', 'DejaVu Sans', Arial, sans-serif";

export const GROWTH_CHART = { width: 680, height: 250 };

const day = (ts: number) =>
  new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Growth of $100 since the first snapshot: the book's time-weighted index
 * against SPY total return, one axis, both starting at 100. Null when there
 * are too few points to draw a line.
 */
export function growthChartSvg(points: GrowthPoint[], name: string): string | null {
  if (points.length < 2) return null;
  const P = EMAIL_PALETTE;
  const hasBench = points.some((p) => p.benchmark != null);
  const series = [
    { name, color: P.book, data: points.map((p) => [p.ts, p.book]) },
    ...(hasBench
      ? [{ name: `${BENCHMARK} (total return)`, color: P.benchmark, data: points.map((p) => [p.ts, p.benchmark]) }]
      : []),
  ];
  const values = points.flatMap((p) => [p.book, p.benchmark]).filter((v): v is number => v != null);
  const pad = Math.max((Math.max(...values) - Math.min(...values)) * 0.12, 1);

  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width: GROWTH_CHART.width,
    height: GROWTH_CHART.height,
  });
  chart.setOption({
    animation: false,
    backgroundColor: P.surface,
    textStyle: { fontFamily: CHART_FONT, color: P.muted, fontSize: 11 },
    legend: {
      top: 4,
      left: 4,
      icon: "roundRect",
      itemWidth: 14,
      itemHeight: 3,
      textStyle: { color: P.ink, fontSize: 12 },
    },
    // Right margin leaves room for the end labels.
    grid: { left: 44, right: 72, top: 36, bottom: 26 },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: P.axis } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { color: P.muted, formatter: (v: number) => day(v), hideOverlap: true },
    },
    yAxis: {
      type: "value",
      scale: true,
      min: Math.floor(Math.min(...values) - pad),
      max: Math.ceil(Math.max(...values) + pad),
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: P.grid } },
      axisLabel: { color: P.muted },
    },
    series: series.map((s) => ({
      type: "line",
      name: s.name,
      data: s.data,
      showSymbol: false,
      connectNulls: true,
      lineStyle: { width: 2, color: s.color },
      itemStyle: { color: s.color },
      endLabel: {
        show: true,
        color: P.ink,
        fontSize: 11,
        fontWeight: 600,
        formatter: ({ value }: { value: [number, number] }) => value[1].toFixed(1),
      },
      // The $100 starting line, once.
      markLine:
        s.name === name
          ? {
              silent: true,
              symbol: "none",
              label: { show: false },
              lineStyle: { color: P.axis, type: "dashed", width: 1 },
              data: [{ yAxis: 100 }],
            }
          : undefined,
    })),
  });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg;
}
