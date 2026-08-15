import { useEffect, useRef } from "react";
import type { EChartsOption } from "echarts";
import * as echarts from "echarts/core";
import {
  BarChart,
  HeatmapChart,
  LineChart,
  PieChart,
  ScatterChart,
  TreemapChart,
} from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { LabelLayout } from "echarts/features";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";
import { RISKDASH_THEME } from "./echartsTheme";
import { REPORT_THEME, REPORT_THEME_NAME } from "./reportTheme";

const THEME_NAME = "riskdash";
echarts.registerTheme(THEME_NAME, RISKDASH_THEME);
echarts.registerTheme(REPORT_THEME_NAME, REPORT_THEME);

/**
 * Only the series and components actually used are registered, so the bundle
 * carries a fraction of full ECharts. Add here when a new chart type is needed
 * — an unregistered series silently renders nothing.
 */
echarts.use([
  BarChart,
  HeatmapChart,
  LineChart,
  PieChart,
  ScatterChart,
  TreemapChart,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
  LabelLayout,
  CanvasRenderer,
  SVGRenderer,
]);

interface Props {
  option: EChartsOption;
  height?: number;
  className?: string;
  theme?: string;
  renderer?: "canvas" | "svg";
}

/**
 * Direct binding to echarts core. Deliberately not using `echarts-for-react`:
 * that wrapper is ~3 years stale and had malware published through a
 * compromised maintainer account in May 2026 (versions 3.1.7 / 3.2.7).
 */
export default function EChartImpl({
  option,
  height = 320,
  className,
  theme = THEME_NAME,
  renderer = "canvas",
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  // Read by the init effect without making `option` one of its dependencies —
  // a fresh instance has to be given the current option immediately, but new
  // data must never tear the chart down and rebuild it.
  const optionRef = useRef(option);
  optionRef.current = option;

  // Created once per (theme, renderer). Both are init-time only in ECharts —
  // neither can be changed on a live instance — so a change to either has to
  // rebuild the chart rather than being silently ignored.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = echarts.init(host, theme, { renderer });
    chartRef.current = chart;
    chart.setOption(optionRef.current, { notMerge: true });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [theme, renderer]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // notMerge avoids stale series lingering when a chart's shape changes
    // (e.g. a ticker leaving the portfolio drops a series). Theme defaults are
    // applied by init and survive notMerge.
    chart.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={hostRef} style={{ height }} className={className} />;
}
