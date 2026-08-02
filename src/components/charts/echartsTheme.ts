import type { EChartsOption } from "echarts";
import { CHART_COLORS, CHART_SEQUENCE, CHART_SURFACE } from "./theme";

/**
 * ECharts styling derived from the same tokens as the Plotly theme, so charts
 * stay consistent while pages migrate one at a time.
 */

/** Diverging ramp for signed P&L. Replaces Plotly's stock RdYlGn, which fights
 *  the steel-blue UI — this uses the app's own gain/loss semantics. */
export const PNL_DIVERGING = [
  CHART_COLORS.loss,
  "#8c4144",
  CHART_SURFACE,
  "#1d6b56",
  CHART_COLORS.gain,
];

/** Single-hue sequential ramp: deep navy (low) → near-white steel (high). */
export const IV_SEQUENTIAL = ["#0b3a5c", "#15527d", "#1f9bdb", "#8fc4e4", "#dfe7ef"];

/**
 * Correlation ramp, ρ = −1 → +1. Deliberately *not* the gain/loss diverging
 * scale: red/green implies good-vs-bad, which correlation doesn't mean, and at
 * portfolio scale most pairs are mildly positive so the whole grid went red.
 * Blue (anti-correlated) → slate (uncorrelated) → near-white (correlated), so
 * the pairs that actually matter are the ones that glow brightest.
 */
export const CORR_DIVERGING = ["#1f9bdb", "#1a4c6b", "#232a33", "#6b7a8c", "#dfe7ef"];

const axisCommon = {
  axisLine: { lineStyle: { color: CHART_COLORS.grid } },
  axisTick: { show: false },
  axisLabel: { color: CHART_COLORS.muted, fontSize: 11 },
  nameTextStyle: { color: CHART_COLORS.muted, fontSize: 11, padding: [8, 0, 0, 0] },
  splitLine: { lineStyle: { color: CHART_COLORS.grid, type: "solid" as const } },
};

/**
 * Registered with ECharts as a *theme*, not spread into each option.
 *
 * A shallow `{...base, ...option}` merge silently loses all of this the moment
 * a chart declares its own `tooltip` (or `legend`, or `grid`) — the whole
 * styled object is replaced by the caller's partial one, and the chart falls
 * back to ECharts' stock white tooltip. Themes merge underneath user options
 * per-property, which is exactly the precedence wanted here.
 */
export const RISKDASH_THEME: EChartsOption = {
  backgroundColor: "transparent",
  color: CHART_SEQUENCE,
  textStyle: {
    fontFamily: "'Inter Variable', Inter, system-ui, sans-serif",
    color: CHART_COLORS.text,
    fontSize: 12,
  },
  animationDuration: 420,
  animationEasing: "cubicOut",
  // See `axisGrid` — containLabel reserves room for tick labels but NOT for
  // axis names, so charts with names need explicit margins on top of it.
  grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
  tooltip: {
    backgroundColor: "#11161f",
    borderColor: "rgba(148,163,184,0.22)",
    borderWidth: 1,
    padding: [8, 11],
    textStyle: { color: CHART_COLORS.text, fontSize: 12 },
    extraCssText:
      "border-radius:8px; box-shadow:0 10px 24px -6px rgba(3,6,12,0.7); backdrop-filter:blur(6px);",
    axisPointer: {
      crossStyle: { color: "rgba(148,163,184,0.35)" },
      lineStyle: { color: "rgba(148,163,184,0.35)" },
      label: { backgroundColor: "#1b2230", color: CHART_COLORS.text },
    },
  },
  legend: {
    top: 0,
    left: 0,
    icon: "roundRect",
    itemWidth: 10,
    itemHeight: 10,
    itemGap: 14,
    textStyle: { color: CHART_COLORS.muted, fontSize: 11 },
  },
  // NOTE: no xAxis/yAxis here on purpose. Every cartesian chart supplies its own
  // via valueAxis/categoryAxis, and defaults at this level leak into axis-less
  // charts — a pie inherits them and renders a stray axis line beside the ring.
};

/**
 * Y-axis names sit `nameGap` px outside the axis line, and ECharts' `containLabel`
 * only reserves space for tick labels — not names. With the default 8px grid the
 * rotated name lands off-canvas and silently disappears. These margins leave room
 * for it; `Y_NAME_GAP` stays below `left + label width` so the name clears the edge.
 */
export const Y_NAME_GAP = 52;
export const X_NAME_GAP = 28;

/** Grid for a cartesian chart that labels both axes. */
export const axisGrid = (opts: { legend?: boolean; right?: number } = {}) => ({
  left: 58,
  right: opts.right ?? 20,
  // A legend rides above the plot; without one the top can be tight.
  top: opts.legend ? 40 : 16,
  bottom: 44,
  containLabel: true,
});

/**
 * Value axis. Always pass the tick formatter through here rather than
 * overriding `axisLabel` at the call site — a bare `axisLabel: { formatter }`
 * replaces the object wholesale and silently drops the label color, leaving
 * near-black ticks on the dark canvas.
 */
export const valueAxis = (
  name?: string,
  formatter?: string | ((v: number) => string),
) => {
  // Reuse the tick formatter for the crosshair readout, so hovering doesn't
  // surface a raw unformatted number next to formatted ticks. Declared
  // unconditionally (undefined when N/A) — a conditional spread would widen the
  // return into a union that ECharts' axis types reject.
  // Param is widened to `unknown`: ECharts types the crosshair value as
  // number | string | Date, and a narrower parameter fails strict contravariance.
  const pointerFormatter =
    typeof formatter === "function"
      ? (p: { value: unknown }) => formatter(Number(p.value))
      : undefined;

  return {
    type: "value" as const,
    name,
    nameLocation: "middle" as const,
    nameGap: Y_NAME_GAP,
    ...axisCommon,
    axisLabel: { ...axisCommon.axisLabel, formatter },
    axisPointer: {
      label: { formatter: pointerFormatter, backgroundColor: "#1b2230" },
    },
  };
};

/** Axis config for a category axis — no split lines, they add noise. */
export const categoryAxis = (name?: string) => ({
  type: "category" as const,
  name,
  nameLocation: "middle" as const,
  nameGap: X_NAME_GAP,
  ...axisCommon,
  splitLine: { show: false },
});

/**
 * A shaded band between two series (e.g. a 25Δ put/call skew band).
 *
 * Plotly draws this with `fill: "tonexty"`. ECharts has no equivalent, so the
 * band is two stacked series: an invisible baseline at `lower`, then the
 * *delta* to `upper` carrying the area fill. Both are excluded from the tooltip
 * and legend so only the real series shows up there.
 */
export function bandSeries(
  a: number[],
  b: number[],
  color = "rgba(31,155,219,0.14)",
  stackId = "band",
) {
  // Order the two edges per point rather than trusting the caller. Equity skew
  // routinely puts 25Δ put IV *above* call IV, which made a naive
  // `upper - lower` negative and drew the band downward off the axis.
  const lower = a.map((v, i) => Math.min(v, b[i]));
  const upper = a.map((v, i) => Math.max(v, b[i]));

  return [
    {
      type: "line" as const,
      stack: stackId,
      data: lower,
      lineStyle: { width: 0 },
      showSymbol: false,
      silent: true,
      tooltip: { show: false },
      itemStyle: { color: "transparent" },
      z: 1,
    },
    {
      type: "line" as const,
      stack: stackId,
      // Stacked, so this series contributes the band's thickness, not its top.
      data: upper.map((v, i) => v - lower[i]),
      lineStyle: { width: 0 },
      showSymbol: false,
      silent: true,
      tooltip: { show: false },
      areaStyle: { color },
      itemStyle: { color: "transparent" },
      z: 1,
    },
  ];
}

/** Compact USD for axis ticks: $1.2k / $3.4M. */
export function axisUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Full-precision USD for tooltips. */
export function tipUsd(v: number): string {
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/**
 * Bins values into a histogram. Plotly auto-binned; ECharts has no histogram
 * series, so the binning moves here. Freedman–Diaconis would over-bin the long
 * tails of a P&L distribution, so this uses a fixed count with nice edges.
 */
export function histogram(values: number[], binCount = 48) {
  if (values.length === 0) return { centers: [] as number[], counts: [] as number[], width: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return { centers: [min], counts: [values.length], width: 1 };

  const width = (max - min) / binCount;
  const counts = new Array<number>(binCount).fill(0);
  for (const v of values) {
    // Clamp keeps the max value inside the last bin rather than overflowing.
    const idx = Math.min(binCount - 1, Math.floor((v - min) / width));
    counts[idx]++;
  }
  const centers = counts.map((_, i) => min + width * (i + 0.5));
  return { centers, counts, width };
}
