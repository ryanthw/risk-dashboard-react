import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import { CHART_COLORS, CHART_SURFACE } from "@/components/charts/theme";
import { IV_SEQUENTIAL, categoryAxis } from "@/components/charts/echartsTheme";
import { BUCKET_ORDER, bucketLabel } from "@/api/ivSurface";
import type { SurfaceExpiration } from "@/api/ivSurface";

/**
 * The surface itself: expiration × delta-bucketed strike, color = IV. Delta
 * bucketing (not raw strike) keeps rows comparable across expiries as spot
 * moves. Hover carries the actual strike/delta behind each cell.
 */
export function IvHeatmap({
  expirations,
  height = 420,
}: {
  expirations: SurfaceExpiration[];
  height?: number;
}) {
  const option = useMemo<EChartsOption>(() => {
    const x = expirations.map((e) => `${e.expiration.slice(5)} · ${e.dte}d`);
    const y = BUCKET_ORDER.map(bucketLabel);

    // ECharts heatmap takes [xIndex, yIndex, value] triples. Cells with no
    // quotable contract are omitted entirely rather than passed as null, so
    // they render as empty rather than as the bottom of the color ramp.
    const data: [number, number, number][] = [];
    const tips = new Map<string, string>();
    let min = Infinity;
    let max = -Infinity;

    BUCKET_ORDER.forEach((b, yi) => {
      expirations.forEach((e, xi) => {
        const hit = e.buckets.find((r) => r.b === b);
        if (hit) {
          const iv = +(hit.iv * 100).toFixed(2);
          data.push([xi, yi, iv]);
          if (iv < min) min = iv;
          if (iv > max) max = iv;
          tips.set(
            `${xi}:${yi}`,
            `${e.expiration} · ${bucketLabel(b)}<br/>strike $${hit.strike} (Δ ${hit.delta.toFixed(2)})` +
              `<br/>IV ${iv.toFixed(2)}% · mid $${hit.mid.toFixed(2)}`,
          );
        }
      });
    });

    return {
      // Right margin reserves room for the visualMap bar and its tick labels;
      // unlike Plotly's colorbar it is not auto-placed outside the plot.
      grid: { left: 56, right: 66, top: 12, bottom: 76, containLabel: true },
      xAxis: {
        ...categoryAxis(),
        data: x,
        axisLabel: { color: CHART_COLORS.muted, fontSize: 10, rotate: -40 },
      },
      yAxis: { ...categoryAxis(), data: y },
      tooltip: {
        trigger: "item",
        formatter: (p: unknown) => {
          const d = p as { value: [number, number, number] };
          return tips.get(`${d.value[0]}:${d.value[1]}`) ?? "";
        },
      },
      visualMap: {
        type: "continuous",
        min: Number.isFinite(min) ? min : 0,
        max: Number.isFinite(max) ? max : 100,
        calculable: true,
        orient: "vertical",
        right: 4,
        top: "middle",
        itemWidth: 10,
        itemHeight: 160,
        precision: 1,
        textStyle: { color: CHART_COLORS.muted, fontSize: 10 },
        formatter: (v: unknown) => `${Number(v).toFixed(0)}%`,
        inRange: { color: IV_SEQUENTIAL },
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
  }, [expirations]);

  if (!expirations.length) return null;
  return <EChart option={option} height={height} />;
}
