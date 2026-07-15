import { useMemo } from "react";
import type { Data, Layout } from "plotly.js-dist-min";
import { Chart } from "@/components/charts/Chart";
import { CHART_COLORS, baseLayout, baseConfig } from "@/components/charts/theme";
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
  const { data, layout } = useMemo(() => {
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
        `${bucketLabel(b)}<br>front ${front.expiration}: ${(f.iv * 100).toFixed(2)}% ($${f.strike})` +
          `<br>back ${back.expiration}: ${(bk.iv * 100).toFixed(2)}% ($${bk.strike})` +
          `<br>differential ${diff >= 0 ? "+" : ""}${diff.toFixed(2)} pts`,
      );
    }

    const data: Data[] = [
      {
        type: "bar",
        x,
        y: yPts,
        customdata: text,
        hovertemplate: "%{customdata}<extra></extra>",
        marker: {
          color: yPts.map((v) => (v >= 0 ? CHART_COLORS.gain : CHART_COLORS.loss)),
          line: { width: 0 },
        },
      },
    ];

    const layout: Partial<Layout> = {
      ...baseLayout,
      height,
      margin: { l: 48, r: 12, t: 8, b: 40 },
      showlegend: false,
      bargap: 0.25,
      xaxis: { ...baseLayout.xaxis, type: "category" },
      yaxis: {
        ...baseLayout.yaxis,
        ticksuffix: " pt",
        zeroline: true,
        zerolinecolor: CHART_COLORS.zeroLine,
      },
    };
    return { data, layout };
  }, [front, back, height]);

  return <Chart data={data} layout={layout} config={baseConfig} height={height} />;
}
