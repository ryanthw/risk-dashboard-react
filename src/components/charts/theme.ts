import type { Layout, Config } from "plotly.js-dist-min";

/** Shared brand palette for charts. */
export const CHART_COLORS = {
  brand: "#1499d6",
  gain: "#22c08a",
  loss: "#e0524d",
  amber: "#e0a82e",
  violet: "#7c6cf0",
  grid: "rgba(148,163,184,0.12)",
  zeroLine: "rgba(148,163,184,0.35)",
  text: "#c7d0dc",
  muted: "#7a8699",
};

/** Categorical color sequence for multi-series charts. */
export const CHART_SEQUENCE = [
  "#1499d6",
  "#22c08a",
  "#e0a82e",
  "#7c6cf0",
  "#e0524d",
  "#2dd4bf",
  "#f472b6",
  "#a3e635",
  "#fb923c",
  "#60a5fa",
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
