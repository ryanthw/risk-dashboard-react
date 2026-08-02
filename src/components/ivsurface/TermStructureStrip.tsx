import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import { CHART_COLORS } from "@/components/charts/theme";
import { bandSeries, categoryAxis, valueAxis } from "@/components/charts/echartsTheme";
import { macroEventsInWindow } from "@/lib/macroEvents";
import type { SurfaceExpiration } from "@/api/ivSurface";

/**
 * ATM IV across every listed expiration 5-40 DTE, with a 25Δ put/call skew
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
  const option = useMemo<EChartsOption>(() => {
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
        `${e.expiration} · ${e.dte}d<br/>ATM IV ${(e.atmIv * 100).toFixed(2)}%` +
        `<br/>±${(movePct * 100).toFixed(1)}% expected move` +
        (spot > 0 ? ` (±$${(movePct * spot).toFixed(2)})` : "")
      );
    });

    // Macro prints inside the surface's date range. The x axis is categorical
    // (one slot per listed expiry), so each event is snapped to the first
    // expiration at or after it — that is the expiry carrying its premium.
    const eventLines: { xAxis: number; label: string }[] = [];
    if (x.length) {
      const today = new Date().toISOString().slice(0, 10);
      for (const ev of macroEventsInWindow(today, x[x.length - 1])) {
        const idx = x.findIndex((d) => d >= ev.date);
        if (idx >= 0) eventLines.push({ xAxis: idx, label: ev.label });
      }
    }

    return {
      grid: { left: 48, right: 12, top: 30, bottom: 40, containLabel: true },
      xAxis: {
        ...categoryAxis(),
        data: x,
        axisLabel: {
          color: CHART_COLORS.muted,
          fontSize: 11,
          formatter: (v: string) => v.slice(5),
        },
      },
      yAxis: valueAxis(undefined, (v: number) => `${v.toFixed(0)}%`),
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line" },
        formatter: (params: unknown) => {
          const arr = params as Array<{ dataIndex: number }>;
          return arr.length ? hover[arr[0].dataIndex] : "";
        },
      },
      series: [
        ...bandSeries(put25, call25),
        {
          type: "line",
          name: "ATM IV",
          data: atm,
          symbolSize: 8,
          lineStyle: { color: CHART_COLORS.brand, width: 2 },
          itemStyle: { color: CHART_COLORS.brand },
          z: 3,
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: CHART_COLORS.amber, width: 1, type: "dotted" },
            label: {
              show: true,
              // Above the plot, matching the old annotation placement — at
              // "start" the labels landed on top of the x-axis tick text.
              position: "end",
              distance: 4,
              color: CHART_COLORS.amber,
              fontSize: 10,
              formatter: (p: { name: string }) => p.name,
            },
            data: eventLines.map((e) => ({ xAxis: e.xAxis, name: e.label })),
          },
        },
      ],
    };
  }, [expirations, spot]);

  if (!expirations.length) return null;
  return <EChart option={option} height={height} />;
}
