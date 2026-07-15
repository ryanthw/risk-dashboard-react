import { useMemo } from "react";
import type { Data, Layout, Shape, Annotations } from "plotly.js-dist-min";
import { Chart } from "@/components/charts/Chart";
import { CHART_COLORS, baseLayout, baseConfig } from "@/components/charts/theme";
import { macroEventsInWindow } from "@/lib/macroEvents";
import type { SurfaceExpiration } from "@/api/ivSurface";

/**
 * ATM IV across every listed expiration <= 40 DTE, with a 25Δ put/call skew
 * band and dashed markers on the macro prints (FOMC / CPI / NFP) that put
 * event premium into a specific expiry. A front expiry spiking above its
 * neighbors right after an event marker is the sell-side of a double diagonal.
 */
export function TermStructureStrip({
  expirations,
  spot,
  height = 260,
}: {
  expirations: SurfaceExpiration[];
  spot: number;
  height?: number;
}) {
  const { data, layout } = useMemo(() => {
    const pts = expirations.filter((e) => e.atmIv > 0);
    const x = pts.map((e) => e.expiration);
    const atm = pts.map((e) => e.atmIv * 100);
    const ivOf = (e: SurfaceExpiration, b: string) =>
      (e.buckets.find((r) => r.b === b)?.iv ?? e.atmIv) * 100;
    const put25 = pts.map((e) => ivOf(e, "P25"));
    const call25 = pts.map((e) => ivOf(e, "C25"));
    const hover = pts.map((e) => {
      const movePct = e.atmIv * Math.sqrt(Math.max(e.dte, 0) / 365);
      return (
        `${e.expiration} · ${e.dte}d<br>ATM IV ${(e.atmIv * 100).toFixed(2)}%` +
        `<br>±${(movePct * 100).toFixed(1)}% expected move` +
        (spot > 0 ? ` (±$${(movePct * spot).toFixed(2)})` : "")
      );
    });

    const data: Data[] = [
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
        showlegend: false,
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

    // Event markers within the surface's date range.
    const shapes: Partial<Shape>[] = [];
    const annotations: Partial<Annotations>[] = [];
    if (x.length) {
      const today = new Date().toISOString().slice(0, 10);
      for (const ev of macroEventsInWindow(today, x[x.length - 1])) {
        shapes.push({
          type: "line",
          xref: "x",
          yref: "paper",
          x0: ev.date,
          x1: ev.date,
          y0: 0,
          y1: 1,
          line: { color: CHART_COLORS.amber, width: 1, dash: "dot" },
        });
        annotations.push({
          xref: "x",
          yref: "paper",
          x: ev.date,
          y: 1.04,
          text: ev.label,
          showarrow: false,
          font: { color: CHART_COLORS.amber, size: 10 },
        });
      }
    }

    const layout: Partial<Layout> = {
      ...baseLayout,
      height,
      margin: { l: 48, r: 12, t: 28, b: 40 },
      showlegend: false,
      xaxis: { ...baseLayout.xaxis, type: "date", tickformat: "%b %d" },
      yaxis: { ...baseLayout.yaxis, ticksuffix: "%" },
      shapes,
      annotations,
    };
    return { data, layout };
  }, [expirations, spot, height]);

  if (!expirations.length) return null;
  return <Chart data={data} layout={layout} config={baseConfig} height={height} />;
}
