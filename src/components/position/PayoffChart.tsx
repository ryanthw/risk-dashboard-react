import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import { CHART_COLORS, CHART_SURFACE } from "@/components/charts/theme";
import { X_NAME_GAP, axisUsd, tipUsd, valueAxis } from "@/components/charts/echartsTheme";

/**
 * Underlying price to the cent.
 *
 * tipUsd rounds to whole dollars, which is right for a P&L figure but throws
 * away the resolution that matters most on the x-axis: on a $6 stock every
 * strike and breakeven lands inside a single dollar, and the readout stops
 * moving as the cursor crosses them.
 */
/**
 * Tick labels for the price axis, at just enough precision to stay distinct.
 *
 * axisUsd rounds to whole dollars, which duplicates ticks as soon as the range
 * slider tightens: a $26 stock at +/-5% spans $2.64, and seven whole-dollar
 * ticks render as "$25 $26 $26 $27 $27 $28 $28". Precision is derived from the
 * tick step ECharts will actually use, so labels stay as short as they can be
 * without two of them reading the same.
 */
function priceTick(span: number): (v: number) => string {
  const step = span / 7;
  const digits = step >= 5 ? 0 : step >= 0.5 ? 1 : 2;
  return (v: number) =>
    `$${v.toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}`;
}

function spotUsd(v: number): string {
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export interface PayoffChartProps {
  prices: number[];
  /** Aggregate P&L at the selected as-of date. */
  pnl: number[];
  /** Aggregate P&L marked to today, drawn faded behind the main curve. */
  today: number[] | null;
  /** Lognormal terminal-price density, or null to hide the shading. */
  density: number[] | null;
  spot: number;
  breakevens: number[];
  asOfLabel: string;
  height?: number;
}

// Series order is load-bearing: the visualMap that paints the curve red below
// zero and green above targets its series by index, so the payoff curve has to
// stay third. Density and the faded "today" line sit beneath it, breakevens on
// top.
const S_PAYOFF = 2;

/**
 * Aggregate payoff curve for one ticker's book — the Robinhood-style view.
 *
 * The red/green split is a `visualMap` on the y dimension rather than two
 * clipped series. ECharts colors the line *and* its area fill from the same
 * map, so the sign change lands exactly on the zero crossing at any zoom, with
 * no seam where two manually-split series would meet.
 */
export function PayoffChart({
  prices,
  pnl,
  today,
  density,
  spot,
  breakevens,
  asOfLabel,
  height = 380,
}: PayoffChartProps) {
  const option = useMemo<EChartsOption>(() => {
    const pairs = (ys: number[]) => prices.map((p, i) => [p, ys[i]]);

    // The visualMap's pieces must be CLOSED intervals. Open-ended `lte`/`gt`
    // pieces give ECharts infinite stop coordinates, and building the area
    // fill's gradient from them throws inside getVisualGradient — a blank
    // chart, not a styling glitch. Bounds come from the data, padded so the
    // extremes fall strictly inside a piece.
    const lo = Math.min(0, ...pnl);
    const hi = Math.max(0, ...pnl);
    const pad = Math.max(1, (hi - lo) * 0.01);

    return {
      grid: { left: 64, right: 24, top: 32, bottom: 48, containLabel: true },
      legend: {
        top: 0,
        left: 0,
        // Naming a series with no data leaves a dead entry in the legend,
        // which is exactly the case on the "Today" view.
        data: [`Payoff at ${asOfLabel}`, ...(today ? ["Value today"] : [])],
      },
      xAxis: {
        ...valueAxis("Underlying Price ($)", priceTick(prices[prices.length - 1] - prices[0])),
        nameGap: X_NAME_GAP,
        min: prices[0],
        max: prices[prices.length - 1],
      },
      // P&L on the left; the density shares the x range but not the scale, so
      // it gets a hidden second axis rather than distorting the P&L ticks.
      yAxis: [
        valueAxis("P&L ($)", axisUsd),
        {
          type: "value" as const,
          show: false,
          splitLine: { show: false },
          // `show: false` hides the axis but not its crosshair readout, which
          // would leak a raw density number onto the right edge.
          axisPointer: { show: false },
        },
      ],
      visualMap: {
        show: false,
        seriesIndex: S_PAYOFF,
        dimension: 1,
        pieces: [
          { min: lo - pad, max: 0, color: CHART_COLORS.loss },
          { min: 0, max: hi + pad, color: CHART_COLORS.gain },
        ],
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        formatter: (params: unknown) => {
          const arr = params as Array<{
            seriesName: string;
            value: [number, number];
            marker: string;
          }>;
          const at = arr.find((p) => p.seriesName.startsWith("Payoff at"));
          if (!at) return "";
          const now = arr.find((p) => p.seriesName === "Value today");
          const move = spot > 0 ? (at.value[0] / spot - 1) * 100 : 0;
          return (
            `Underlying ${spotUsd(at.value[0])}` +
            `<span style="color:${CHART_COLORS.muted}"> (${move >= 0 ? "+" : ""}${move.toFixed(1)}%)</span><br/>` +
            `${at.marker}${asOfLabel} <b>${tipUsd(at.value[1])}</b>` +
            (now ? `<br/>${now.marker}Today <b>${tipUsd(now.value[1])}</b>` : "")
          );
        },
      },
      series: [
        {
          type: "line" as const,
          name: "Price Probability",
          yAxisIndex: 1,
          data: density ? pairs(density) : [],
          showSymbol: false,
          lineStyle: { width: 0 },
          areaStyle: { color: "rgba(31,155,219,0.12)" },
          silent: true,
          tooltip: { show: false },
          z: 1,
        },
        {
          type: "line" as const,
          name: "Value today",
          data: today ? pairs(today) : [],
          showSymbol: false,
          lineStyle: { color: CHART_COLORS.muted, width: 1.5, type: "dashed" as const },
          itemStyle: { color: CHART_COLORS.muted },
          z: 2,
        },
        {
          type: "line" as const,
          name: `Payoff at ${asOfLabel}`,
          data: pairs(pnl),
          showSymbol: false,
          lineStyle: { width: 2.5 },
          // Fills to the zero line (origin "auto" uses the axis zero when it is
          // inside the range), which is what makes the red and green bands read
          // as profit and loss rather than as shading under a line.
          areaStyle: { opacity: 0.16, origin: "auto" as const },
          z: 3,
          markLine: {
            silent: true,
            symbol: "none",
            data: [
              {
                yAxis: 0,
                label: { show: false },
                lineStyle: { color: "rgba(255,255,255,0.35)", width: 1, type: "dashed" as const },
              },
              {
                xAxis: spot,
                label: {
                  show: true,
                  formatter: `Spot ${spotUsd(spot)}`,
                  position: "insideEndTop" as const,
                  color: CHART_COLORS.amber,
                  fontSize: 11,
                },
                lineStyle: { color: CHART_COLORS.amber, width: 1.5, type: "dotted" as const },
              },
            ],
          },
        },
        {
          type: "scatter" as const,
          name: "Breakeven",
          data: breakevens.map((b) => [b, 0]),
          symbolSize: 9,
          itemStyle: {
            // Filled with the page canvas and ringed in text grey, so a
            // breakeven reads as a marker rather than a point on the curve.
            color: CHART_SURFACE,
            borderColor: CHART_COLORS.text,
            borderWidth: 1.5,
          },
          label: {
            show: true,
            position: "bottom" as const,
            // Param widened to `unknown` for the same reason valueAxis widens
            // its pointer formatter: ECharts types the callback argument as
            // CallbackDataParams, and a narrower parameter fails strict
            // contravariance under `tsc -b`.
            formatter: (p: { value: unknown }) => {
              const v = p.value as [number, number];
              return `BE ${v[0].toFixed(2)}`;
            },
            color: CHART_COLORS.muted,
            fontSize: 10,
          },
          silent: true,
          tooltip: { show: false },
          z: 4,
        },
      ],
    };
  }, [prices, pnl, today, density, spot, breakevens, asOfLabel]);

  return <EChart option={option} height={height} />;
}
