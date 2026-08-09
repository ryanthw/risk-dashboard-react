import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "./EChart";
import { CHART_COLORS, CHART_SURFACE, mixHex } from "./theme";
import { axisGrid, axisUsd, categoryAxis, tipUsd, valueAxis } from "./echartsTheme";
import type { Snapshot } from "@/types";

interface EquityCurveProps {
  snapshots: Snapshot[];
  height?: number;
  /** Draw a dashed line at the high-water mark. */
  highWaterMark?: number | null;
}

/**
 * Net liquidity over time. Shared by Dashboard and History so the two pages
 * can't drift apart on how the series is drawn.
 */
export function EquityCurve({ snapshots, height = 340, highWaterMark }: EquityCurveProps) {
  const option = useMemo<EChartsOption>(() => {
    const up =
      snapshots.length > 1 &&
      (snapshots[snapshots.length - 1].net_liquidity ?? 0) >= (snapshots[0].net_liquidity ?? 0);
    const line = up ? CHART_COLORS.brand : CHART_COLORS.loss;
    return {
      grid: { ...axisGrid(), left: 8, bottom: 32 },
      xAxis: { ...categoryAxis(), type: "time" as const, name: undefined },
      yAxis: valueAxis(undefined, axisUsd),
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        valueFormatter: (v: unknown) => tipUsd(Number(v)),
      },
      series: [
        {
          type: "line",
          name: "Net Liquidity",
          // Straight segments: these are discrete daily snapshots, and a spline
          // invents intermediate values that were never observed.
          smooth: false,
          symbolSize: 6,
          data: snapshots.map((s) => [s.ts, s.net_liquidity] as [string, number]),
          lineStyle: { color: line, width: 2.5 },
          itemStyle: { color: line },
          areaStyle: { color: mixHex(line, CHART_SURFACE, 0.78), opacity: 0.6 },
          ...(highWaterMark != null && Number.isFinite(highWaterMark)
            ? {
                markLine: {
                  silent: true,
                  symbol: "none",
                  data: [{ yAxis: highWaterMark, name: "High-water mark" }],
                  // CHART_COLORS.grid is tuned for gridlines and disappears as a
                  // markLine, so use the text color held back with opacity.
                  lineStyle: {
                    color: CHART_COLORS.text,
                    opacity: 0.4,
                    type: "dashed" as const,
                    width: 1.5,
                  },
                  label: {
                    formatter: "HWM",
                    color: CHART_COLORS.text,
                    fontSize: 10,
                    position: "insideEndTop" as const,
                  },
                },
              }
            : {}),
        },
      ],
    };
  }, [snapshots, highWaterMark]);

  return <EChart height={height} option={option} />;
}
