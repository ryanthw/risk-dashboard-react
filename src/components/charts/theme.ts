import type { Layout, Config } from "plotly.js-dist-min";

/**
 * Shared brand palette for charts, aligned with the app's deep-slate +
 * financial-blue UI tokens (--primary / --gain / --loss in index.css).
 */
export const CHART_COLORS = {
  brand: "#1f9bdb",
  gain: "#2bb789",
  loss: "#e15554",
  amber: "#e0a82e",
  violet: "#8b7cf6",
  grid: "rgba(148,163,184,0.12)",
  zeroLine: "rgba(148,163,184,0.35)",
  text: "#c7d0dc",
  muted: "#7a8699",
};

/**
 * Categorical color sequence for multi-series charts. Anchored on the brand
 * blue and kept cool/harmonious with the slate theme — blues, teals, cyan and
 * indigo lead, with amber/rose reserved as later-index accents.
 */
export const CHART_SEQUENCE = [
  "#1f9bdb", // brand blue
  "#2bb789", // emerald (gain)
  "#38bdf8", // sky
  "#8b7cf6", // violet
  "#22d3ee", // cyan
  "#5e8bff", // periwinkle
  "#2dd4bf", // teal
  "#e0a82e", // amber accent
  "#f4799e", // rose accent
  "#94a3b8", // slate
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
