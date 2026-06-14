import type { Layout, Config } from "plotly.js-dist-min";

/**
 * Shared brand palette for charts, aligned with the app's deep-slate +
 * financial-blue UI tokens (--primary / --gain / --loss in index.css).
 */
export const CHART_COLORS = {
  brand: "#1f9bdb",
  gain: "#2bb789",
  loss: "#e15554",
  amber: "#d9a441",
  violet: "#5d6fd1",
  grid: "rgba(148,163,184,0.12)",
  zeroLine: "rgba(148,163,184,0.35)",
  text: "#c7d0dc",
  muted: "#7a8699",
};

/**
 * Categorical color sequence for multi-series charts. Industrial blue / steel /
 * white ramp matching the site's dark financial theme — no pastels. Ordered to
 * alternate light/dark/blue so adjacent slices and bars stay distinguishable.
 */
export const CHART_SEQUENCE = [
  "#1f9bdb", // brand blue
  "#dfe7ef", // near-white steel
  "#15527d", // deep navy
  "#5fa8d6", // soft mid blue
  "#3f5871", // slate steel
  "#0ea5e9", // sky blue
  "#9fb1c4", // light steel
  "#0b3a5c", // darkest navy
  "#6b7f95", // muted steel
  "#2b6cb0", // royal blue
];

/** Base dark layout merged into every chart. */
export const baseLayout: Partial<Layout> = {
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  font: { family: "Inter, system-ui, sans-serif", color: CHART_COLORS.text, size: 12 },
  margin: { l: 56, r: 24, t: 36, b: 44 },
  colorway: CHART_SEQUENCE,
  xaxis: {
    gridcolor: CHART_COLORS.grid,
    zerolinecolor: CHART_COLORS.zeroLine,
    linecolor: CHART_COLORS.grid,
    tickfont: { color: CHART_COLORS.muted },
  },
  yaxis: {
    gridcolor: CHART_COLORS.grid,
    zerolinecolor: CHART_COLORS.zeroLine,
    linecolor: CHART_COLORS.grid,
    tickfont: { color: CHART_COLORS.muted },
  },
  legend: {
    bgcolor: "rgba(0,0,0,0)",
    font: { color: CHART_COLORS.muted, size: 11 },
    orientation: "h",
    yanchor: "bottom",
    y: 1.02,
    x: 0,
  },
  hoverlabel: {
    bgcolor: "#11161f",
    bordercolor: CHART_COLORS.grid,
    font: { color: CHART_COLORS.text },
  },
};

export const baseConfig: Partial<Config> = {
  displayModeBar: false,
  responsive: true,
};
