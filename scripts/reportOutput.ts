/**
 * The network and filesystem half of the email report: fetching the
 * benchmark, rasterising charts, and writing the files the sender reads.
 * Separate from report.ts so a preview can run this exact path from rows
 * already on disk, without signing in.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { BENCHMARK, parseYahooChart, type PriceBar } from "@/report/benchmark";
import { GROWTH_CHART, growthChartSvg } from "@/report/charts";
import type { ReportModel } from "@/report/portfolioReport";
import { renderEmail, type ImageRefs } from "@/report/renderEmail";

/**
 * SPY daily bars from Yahoo's chart endpoint — the same source the
 * market-data edge function uses for history, called directly because that
 * function returns closes without their dates. Both Yahoo hosts are tried;
 * failure is not fatal: the report goes out without the comparison and says
 * so, rather than not going out.
 */
export async function fetchBenchmark(fromMs: number): Promise<PriceBar[] | null> {
  // A week of slack before the first snapshot, so it has a prior close to align to.
  const p1 = Math.floor(fromMs / 1000) - 7 * 86_400;
  const p2 = Math.floor(Date.now() / 1000) + 86_400;
  const query = `period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const r = await fetch(`https://${host}/v8/finance/chart/${BENCHMARK}?${query}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        console.error(`${BENCHMARK} fetch from ${host}: HTTP ${r.status}`);
        continue;
      }
      const bars = parseYahooChart(await r.json());
      if (bars.length) return bars;
      console.error(`${BENCHMARK} fetch from ${host}: no usable bars`);
    } catch (e) {
      console.error(`${BENCHMARK} fetch from ${host}: ${(e as Error).message}`);
    }
  }
  return null;
}

/**
 * SVG to PNG at 2x for high-density screens. Text resolves against system
 * fonts; the default covers a family list with nothing installed — Segoe UI on
 * a Windows dev box, DejaVu Sans on the Ubuntu runner.
 */
function png(svg: string, width: number): Buffer {
  return new Resvg(svg, {
    fitTo: { mode: "width", value: width * 2 },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: process.platform === "win32" ? "Segoe UI" : "DejaVu Sans",
    },
  })
    .render()
    .asPng();
}

/**
 * Write subject.txt, report.txt, report.html (images as cid:<name>), one
 * <name>.png per image, and preview.html (the same page with file references).
 * Returns the subject.
 */
export function writeReport(model: ReportModel, dir: string): string {
  mkdirSync(dir, { recursive: true });

  // Images, by the name the HTML and the sender both key on.
  const images: Record<string, Buffer> = {
    logo: png(readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8"), 32),
  };
  const chart = growthChartSvg(model.growth, model.portfolioName);
  if (chart) images.growth = png(chart, GROWTH_CHART.width);
  for (const [name, buf] of Object.entries(images)) writeFileSync(join(dir, `${name}.png`), buf);

  const refs = (src: (name: string) => string): ImageRefs =>
    Object.fromEntries(Object.keys(images).map((n) => [n, src(n)]));
  const email = renderEmail(model, refs((n) => `cid:${n}`));
  writeFileSync(join(dir, "subject.txt"), email.subject);
  writeFileSync(join(dir, "report.html"), email.html);
  writeFileSync(join(dir, "report.txt"), email.text);
  writeFileSync(join(dir, "preview.html"), renderEmail(model, refs((n) => `${n}.png`)).html);
  return email.subject;
}
