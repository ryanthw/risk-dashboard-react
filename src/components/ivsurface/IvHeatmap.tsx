import { useMemo } from "react";
import type { Data, Layout } from "plotly.js-dist-min";
import { Chart } from "@/components/charts/Chart";
import { baseLayout, baseConfig } from "@/components/charts/theme";
import { BUCKET_ORDER, bucketLabel } from "@/api/ivSurface";
import type { SurfaceExpiration } from "@/api/ivSurface";

// Sequential blue ramp (single hue, monotone lightness on the dark surface):
// dark navy = low IV, near-white steel = high IV.
const IV_COLORSCALE: Array<[number, string]> = [
  [0, "#0b3a5c"],
  [0.5, "#1f9bdb"],
  [1, "#dfe7ef"],
];

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
  const { data, layout } = useMemo(() => {
    const x = expirations.map((e) => `${e.expiration.slice(5)} · ${e.dte}d`);
    const y = BUCKET_ORDER.map(bucketLabel);

    const z: (number | null)[][] = [];
    const text: string[][] = [];
    for (const b of BUCKET_ORDER) {
      const zRow: (number | null)[] = [];
      const tRow: string[] = [];
      for (const e of expirations) {
        const hit = e.buckets.find((r) => r.b === b);
        zRow.push(hit ? +(hit.iv * 100).toFixed(2) : null);
        tRow.push(
          hit
            ? `${e.expiration} · ${bucketLabel(b)}<br>strike $${hit.strike} (Δ ${hit.delta.toFixed(2)})` +
                `<br>IV ${(hit.iv * 100).toFixed(2)}% · mid $${hit.mid.toFixed(2)}`
            : `${e.expiration} · ${bucketLabel(b)}<br>no quotable contract`,
        );
      }
      z.push(zRow);
      text.push(tRow);
    }

    const data: Data[] = [
      {
        type: "heatmap",
        x,
        y,
        z,
        text: text as unknown as string[],
        hovertemplate: "%{text}<extra></extra>",
        colorscale: IV_COLORSCALE,
        xgap: 2,
        ygap: 2,
        colorbar: {
          ticksuffix: "%",
          thickness: 10,
          outlinewidth: 0,
          tickfont: { size: 10, color: "#7a8699" },
        },
      },
    ];

    const layout: Partial<Layout> = {
      ...baseLayout,
      height,
      margin: { l: 56, r: 8, t: 8, b: 64 },
      xaxis: { ...baseLayout.xaxis, type: "category", tickangle: -40 },
      yaxis: { ...baseLayout.yaxis, type: "category" },
    };
    return { data, layout };
  }, [expirations, height]);

  if (!expirations.length) return null;
  return <Chart data={data} layout={layout} config={baseConfig} height={height} />;
}
