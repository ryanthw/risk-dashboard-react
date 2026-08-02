/**
 * Shared brand palette and color math for charts, aligned with the app's
 * deep-slate + financial-blue UI tokens (--primary / --gain / --loss in
 * index.css). Rendering-specific styling lives in echartsTheme.ts.
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

/** The page canvas behind charts — used for tile borders and shading targets. */
export const CHART_SURFACE = "#0c0e13";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const to = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Linear blend between two hex colors. `amount` 0 → `a`, 1 → `b`. */
export function mixHex(a: string, b: string, amount: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]);
}

/** WCAG relative luminance, 0 (black) → 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Pulls a palette entry down into a dark band so light text stays legible on
 * top of it. CHART_SEQUENCE deliberately contains near-white steels for line
 * charts, which are unusable as filled tile backgrounds.
 *
 * The 0.095 ceiling is what CHART_COLORS.text needs to clear 4.5:1 — it lets a
 * single text color stay readable on every tile, so no per-node text array is
 * required. Verified worst case across the palette: 4.74:1.
 */
export function toTileTone(hex: string, maxLum = 0.095): string {
  let out = hex;
  // Blending is monotonic in luminance, so a fixed number of steps converges.
  for (let i = 0; i < 24 && luminance(out) > maxLum; i++) {
    out = mixHex(out, CHART_SURFACE, 0.12);
  }
  return out;
}
