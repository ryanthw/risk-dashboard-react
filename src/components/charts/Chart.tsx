import { lazy, Suspense } from "react";
import type { Data, Layout, Config } from "plotly.js-dist-min";

const PlotlyChart = lazy(() => import("./PlotlyChart"));

interface ChartProps {
  data: Data[];
  layout?: Partial<Layout>;
  config?: Partial<Config>;
  height?: number;
  className?: string;
}

function ChartSkeleton({ height = 320 }: { height?: number }) {
  return (
    <div
      className="flex w-full animate-pulse items-center justify-center rounded-lg bg-muted/30"
      style={{ height }}
    >
      <span className="text-xs text-muted-foreground">Rendering chart…</span>
    </div>
  );
}

/** Lazy-loaded Plotly chart — keeps the ~1MB Plotly bundle out of the main chunk. */
export function Chart(props: ChartProps) {
  return (
    <Suspense fallback={<ChartSkeleton height={props.height} />}>
      <PlotlyChart {...props} />
    </Suspense>
  );
}
