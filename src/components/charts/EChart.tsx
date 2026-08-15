import { lazy, Suspense } from "react";
import type { EChartsOption } from "echarts";

const EChartImpl = lazy(() => import("./EChartImpl"));

interface EChartProps {
  option: EChartsOption;
  height?: number;
  className?: string;
  /** Registered theme name. Defaults to the app's dark theme. */
  theme?: string;
  /**
   * "svg" for anything that will be printed — a canvas chart rasterizes into
   * the PDF at screen resolution, while SVG stays vector and stays sharp.
   */
  renderer?: "canvas" | "svg";
}

function ChartSkeleton({ height = 320 }: { height?: number }) {
  return <div className="skeleton w-full rounded-lg" style={{ height }} />;
}

/**
 * Lazy-loaded ECharts wrapper, mirroring the existing `Chart` seam so pages can
 * migrate off Plotly one at a time. Keeps the charting engine out of the main
 * chunk either way.
 */
export function EChart(props: EChartProps) {
  return (
    <Suspense fallback={<ChartSkeleton height={props.height} />}>
      <EChartImpl {...props} />
    </Suspense>
  );
}
