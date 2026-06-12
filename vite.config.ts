import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Plotly is heavy; it is isolated into its own async chunk via the
    // React.lazy import in components/charts/Chart.tsx.
    chunkSizeWarningLimit: 1500,
  },
});
