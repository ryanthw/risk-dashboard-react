import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import { CHART_COLORS } from "@/components/charts/theme";
import { categoryAxis, valueAxis } from "@/components/charts/echartsTheme";
import { BUCKET_ORDER, bucketLabel } from "@/api/ivSurface";
import type { SurfaceExpiration } from "@/api/ivSurface";

/**
 * Front-minus-back IV per delta bucket for one expiry pair — the double
 * diagonal's edge, made visible. Bars above zero: the front (short) expiry is
 * richer than the back (long) at that part of the smile — that's what the
 * structure wants. Diverging gain/loss color reinforces the bar direction.
 */
export function PairDiffChart({
  front,
  back,
  height = 260,
}: {
  front: SurfaceExpiration;
  back: SurfaceExpiration;
  height?: number;
}) {
  const option = useMemo<EChartsOption>(() => {
    const x: string[] = [];
    const yPts: number[] = [];
    const text: string[] = [];
    for (const b of BUCKET_ORDER) {
      const f = front.buckets.find((r) => r.b === b);
      const bk = back.buckets.find((r) => r.b === b);
      if (!f || !bk) continue;
      const diff = (f.iv - bk.iv) * 100;
      x.push(bucketLabel(b));
      yPts.push(+diff.toFixed(2));
      text.push(
        `${bucketLabel(b)}<br/>front ${front.expiration}: ${(f.iv * 100).toFixed(2)}% ($${f.strike})` +
          `<br/>back ${back.expiration}: ${(bk.iv * 100).toFixed(2)}% ($${bk.strike})` +
          `<br/>differential ${diff >= 0 ? "+" : ""}${diff.toFixed(2)} pts`,
      );
    }

    return {
      grid: { left: 48, right: 12, top: 12, bottom: 40, containLabel: true },
      xAxis: { ...categoryAxis(), data: x },
      yAxis: valueAxis(undefined, (v: number) => `${v.toFixed(1)} pt`),
      tooltip: {
        trigger: "item",
        formatter: (p: unknown) => text[(p as { dataIndex: number }).dataIndex],
      },
      series: [
        {
          type: "bar",
          data: yPts.map((v) => ({
            value: v,
            itemStyle: { color: v >= 0 ? CHART_COLORS.gain : CHART_COLORS.loss },
          })),
          barCategoryGap: "25%",
          // Plotly drew a zero line via the axis; ECharts needs it explicit.
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: CHART_COLORS.zeroLine, width: 1 },
            data: [{ yAxis: 0 }],
          },
        },
      ],
    };
  }, [front, back]);

  return <EChart option={option} height={height} />;
}
