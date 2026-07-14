import { useMemo } from "react";
import type { Data, Layout } from "plotly.js-dist-min";
import { Chart } from "@/components/charts/Chart";
import { CHART_COLORS, baseLayout, baseConfig } from "@/components/charts/theme";
import type { ExpSummary } from "@/api/basis";

/**
 * IV term structure across upcoming expirations: ATM IV line with a 25Δ
 * put/call skew band (same measure, one axis). Hover shows the ATM-IV
 * expected move to each expiration.
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
  const { data, layout } = useMemo(() => {
    const pts = expirations.filter((e) => e.atmIv > 0);
    const x = pts.map((e) => e.expiration);
    const atm = pts.map((e) => e.atmIv * 100);
    const put25 = pts.map((e) => (e.put25Iv ?? e.atmIv) * 100);
    const call25 = pts.map((e) => (e.call25Iv ?? e.atmIv) * 100);
    const hover = pts.map(
      (e) =>
        `${e.expiration} · ${e.dte}d<br>ATM IV ${(e.atmIv * 100).toFixed(1)}%` +
        `<br>±${(e.expectedMovePct * 100).toFixed(1)}% expected move` +
        (spot > 0 ? ` (±$${(e.expectedMovePct * spot).toFixed(2)})` : ""),
    );

    const data: Data[] = [
      // Skew band: 25Δ call IV -> 25Δ put IV, translucent brand fill.
      {
        x,
        y: call25,
        type: "scatter",
        mode: "lines",
        line: { width: 0 },
        hoverinfo: "skip",
        showlegend: false,
      },
      {
        x,
        y: put25,
        type: "scatter",
        mode: "lines",
        line: { width: 0 },
        fill: "tonexty",
        fillcolor: "rgba(31,155,219,0.14)",
        name: "25Δ put–call band",
        hoverinfo: "skip",
        showlegend: true,
      },
      {
        x,
        y: atm,
        type: "scatter",
        mode: "lines+markers",
        name: "ATM IV",
        line: { color: CHART_COLORS.brand, width: 2 },
        marker: { color: CHART_COLORS.brand, size: 8 },
        text: hover,
        hovertemplate: "%{text}<extra></extra>",
      },
    ];

    const layout: Partial<Layout> = {
      ...baseLayout,
      height,
      margin: { l: 44, r: 8, t: 8, b: 36 },
      showlegend: false,
      xaxis: { ...baseLayout.xaxis, type: "category", tickangle: -35 },
      yaxis: { ...baseLayout.yaxis, ticksuffix: "%", rangemode: "tozero" },
    };
    return { data, layout };
  }, [expirations, spot, height]);

  if (!expirations.length) return null;
  return <Chart data={data} layout={layout} config={baseConfig} height={height} />;
}
