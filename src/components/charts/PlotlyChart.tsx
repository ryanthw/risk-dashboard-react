import { useMemo } from "react";
import Plotly from "plotly.js-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";
import type { Data, Layout, Config } from "plotly.js-dist-min";
import { baseLayout, baseConfig } from "./theme";

// Build the React component against the lightweight dist-min bundle.
const Plot = createPlotlyComponent(Plotly);

interface PlotlyChartProps {
  data: Data[];
  layout?: Partial<Layout>;
  config?: Partial<Config>;
  height?: number;
  className?: string;
}

/** Deep-merges a chart's layout over the shared dark theme. */
function mergeLayout(layout?: Partial<Layout>): Partial<Layout> {
  return {
    ...baseLayout,
    ...layout,
    xaxis: { ...baseLayout.xaxis, ...layout?.xaxis },
    yaxis: { ...baseLayout.yaxis, ...layout?.yaxis },
    legend: { ...baseLayout.legend, ...layout?.legend },
    font: { ...baseLayout.font, ...layout?.font },
  };
}

/**
 * Default-exported so pages can React.lazy() it and keep Plotly out of the
 * main bundle.
 */
export default function PlotlyChart({
  data,
  layout,
  config,
  height = 320,
  className,
}: PlotlyChartProps) {
  const mergedLayout = useMemo(() => mergeLayout(layout), [layout]);
  const mergedConfig = useMemo(() => ({ ...baseConfig, ...config }), [config]);

  return (
    <Plot
      data={data}
      layout={{ autosize: true, height, ...mergedLayout }}
      config={mergedConfig}
      useResizeHandler
      style={{ width: "100%", height: `${height}px` }}
      className={className}
    />
  );
}
