/**
 * Light chart palette for the printed report.
 *
 * The app is a dark theme; paper is not. Rather than inverting the dark tokens
 * at print time — which drops the near-white steels in CHART_SEQUENCE to
 * invisible and pushes #e15554 to a pink that no printer reproduces — the
 * report gets its own small palette, chosen against a white ground.
 *
 * The three colors were checked for lightness band, chroma, CVD separation and
 * contrast against a white surface. The gain/loss pair clears every check
 * including protanope separation; it is also never the only cue, since signed
 * bars carry direction and a printed value.
 */
import type { EChartsOption } from "echarts";

export const REPORT_COLORS = {
  /** Single-series line color — the equity curve. */
  series: "#1B6FAE",
  gain: "#0F7D5C",
  loss: "#C24326",
  /** Ink for labels and values. */
  text: "#1F2933",
  muted: "#5A6675",
  grid: "rgba(31,41,51,0.10)",
  zeroLine: "rgba(31,41,51,0.30)",
  surface: "#FFFFFF",
};

/** Fill under the equity line — the series color at paper-safe opacity. */
export const REPORT_AREA = "rgba(27,111,174,0.13)";

export const REPORT_THEME_NAME = "riskdash-report";

const axisCommon = {
  axisLine: { lineStyle: { color: REPORT_COLORS.grid } },
  axisTick: { show: false },
  axisLabel: { color: REPORT_COLORS.muted, fontSize: 10 },
  nameTextStyle: { color: REPORT_COLORS.muted, fontSize: 10, padding: [6, 0, 0, 0] },
  splitLine: { lineStyle: { color: REPORT_COLORS.grid, type: "solid" as const } },
};

export const reportValueAxis = (formatter?: (v: number) => string) => ({
  type: "value" as const,
  ...axisCommon,
  axisLabel: { ...axisCommon.axisLabel, formatter },
});

export const reportCategoryAxis = () => ({
  type: "category" as const,
  ...axisCommon,
  splitLine: { show: false },
});

/**
 * Registered as a theme rather than merged into each option, for the same
 * reason RISKDASH_THEME is: a chart that declares its own `tooltip` or `grid`
 * would otherwise replace the styled object wholesale.
 *
 * Animation is off. The report exists to be printed, and a chart caught
 * mid-transition by the print dialog renders half-drawn.
 */
export const REPORT_THEME: EChartsOption = {
  backgroundColor: "transparent",
  color: [REPORT_COLORS.series, REPORT_COLORS.gain, REPORT_COLORS.loss],
  textStyle: {
    fontFamily: "'Inter Variable', Inter, system-ui, sans-serif",
    color: REPORT_COLORS.text,
    fontSize: 11,
  },
  animation: false,
  grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
  tooltip: {
    backgroundColor: "#FFFFFF",
    borderColor: "rgba(31,41,51,0.18)",
    borderWidth: 1,
    padding: [7, 10],
    textStyle: { color: REPORT_COLORS.text, fontSize: 11 },
    extraCssText: "border-radius:6px; box-shadow:0 6px 16px -6px rgba(31,41,51,0.28);",
  },
  legend: {
    top: 0,
    left: 0,
    icon: "roundRect",
    itemWidth: 10,
    itemHeight: 10,
    itemGap: 14,
    textStyle: { color: REPORT_COLORS.muted, fontSize: 10 },
  },
};

/** Compact USD for report axis ticks. */
export function reportUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}
