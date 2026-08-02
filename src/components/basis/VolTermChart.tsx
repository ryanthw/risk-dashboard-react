import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import { CHART_COLORS } from "@/components/charts/theme";
import { categoryAxis, valueAxis } from "@/components/charts/echartsTheme";
import type { ExpSummary } from "@/api/basis";

/**
 * ATM IV term structure across upcoming expirations. The 25Δ skew band was
 * dropped here — the shading fought the line at this card size, and the level
 * of IV by expiry is what the basis view is actually read for. The full skew
 * band still lives on the IV Surface page.
 */
export function VolTermChart({
  expirations,
  spot,
  height = 190,
}: {
  expirations: ExpSummary[];
  spot: number;
  height?: number;
}) {
  const option = useMemo<EChartsOption>(() => {
    const pts = expirations.filter((e) => e.atmIv > 0);
    const x = pts.map((e) => e.expiration);
    const atm = pts.map((e) => e.atmIv * 100);
    const hover = pts.map(
      (e) =>
        `${e.expiration} · ${e.dte}d<br/>ATM IV ${(e.atmIv * 100).toFixed(1)}%` +
        `<br/>±${(e.expectedMovePct * 100).toFixed(1)}% expected move` +
        (spot > 0 ? ` (±$${(e.expectedMovePct * spot).toFixed(2)})` : ""),
    );

    return {
      grid: { left: 44, right: 8, top: 10, bottom: 44, containLabel: true },
      xAxis: {
        ...categoryAxis(),
        data: x,
        axisLabel: { color: CHART_COLORS.muted, fontSize: 11, rotate: -35 },
      },
      yAxis: {
        ...valueAxis(undefined, (v: number) => `${v.toFixed(0)}%`),
        // Fit the axis to the data rather than anchoring at zero. IVs here sit
        // anywhere from 30% to 180%, and forcing zero flattened the term
        // structure into a near-straight line at the top of the plot.
        scale: true,
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line" },
        // Band series are silent, so only the ATM point reaches here.
        formatter: (params: unknown) => {
          const arr = params as Array<{ dataIndex: number }>;
          return arr.length ? hover[arr[0].dataIndex] : "";
        },
      },
      series: [
        {
          type: "line",
          name: "ATM IV",
          data: atm,
          symbolSize: 8,
          // Straight segments between listed expirations — the curve between
          // two expiries isn't observed, so don't draw one.
          smooth: false,
          lineStyle: { color: CHART_COLORS.brand, width: 2 },
          itemStyle: { color: CHART_COLORS.brand },
        },
      ],
    };
  }, [expirations, spot]);

  if (!expirations.length) return null;
  return <EChart option={option} height={height} />;
}
