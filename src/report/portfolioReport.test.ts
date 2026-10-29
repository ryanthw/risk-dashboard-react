import { describe, expect, it } from "vitest";
import type { PriceBar } from "@/report/benchmark";
import { growthChartSvg } from "@/report/charts";
import { buildReport, windowReturn } from "@/report/portfolioReport";
import { esc, renderEmail } from "@/report/renderEmail";
import type { CashFlow, Portfolio, Snapshot } from "@/types";

// Synthetic fixtures: this repo is public and the real book is not.

const DAY = 86_400_000;
const NOW = new Date("2026-06-30T22:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

const snap = (daysAgo: number, net_liquidity: number) =>
  ({ id: `s${daysAgo}`, ts: ago(daysAgo), net_liquidity }) as Snapshot;
const flow = (daysAgo: number, amount: number, kind: CashFlow["kind"] = "deposit") =>
  ({ id: `f${daysAgo}`, ts: ago(daysAgo), amount, kind }) as CashFlow;
/** A bar whose close printed an hour before the snapshot `daysAgo` days back. */
const bar = (daysAgo: number, close: number): PriceBar => ({
  closeTs: NOW.getTime() - daysAgo * DAY - 3_600_000,
  close,
});

describe("windowReturn", () => {
  it("strips deposits out of the return", () => {
    // 1000 -> 1600 with a 500 deposit in between: 100 of trading on 1000.
    const r = windowReturn([snap(40, 1000), snap(20, 1550), snap(0, 1600)], [flow(20, 500)], 30, "1M");
    expect(r.from).toBe(ago(40));
    expect(r.tradingPnl).toBeCloseTo(100);
    expect(r.ret!).toBeGreaterThan(0.05);
    expect(r.ret!).toBeLessThan(0.11);
  });

  it("is null rather than shortened when history does not reach back", () => {
    const r = windowReturn([snap(40, 1000), snap(0, 1100)], [], 91, "3M");
    expect(r.ret).toBeNull();
    expect(r.benchmark).toBeNull();
  });

  it("measures from the last snapshot at or before the window start", () => {
    const r = windowReturn([snap(50, 900), snap(35, 1000), snap(10, 1050), snap(0, 1100)], [], 30, "1M");
    expect(r.from).toBe(ago(35));
    expect(r.ret).toBeCloseTo(0.1);
  });

  it("compares against the benchmark over exactly the same span", () => {
    const bars = [bar(50, 400), bar(35, 500), bar(10, 520), bar(0, 525)];
    const r = windowReturn([snap(50, 900), snap(35, 1000), snap(0, 1100)], [], 30, "1M", bars);
    expect(r.benchmark).toBeCloseTo(0.05); // 500 -> 525, not 400 -> 525
    expect(r.excess).toBeCloseTo(0.05); // book +10% against +5%
  });
});

describe("buildReport", () => {
  const base = {
    portfolio: { id: "p", name: "Test Book", cash: 5000 } as Portfolio,
    trades: [],
    cashFlows: [],
    stats: [],
    closed: [],
    benchmark: [bar(100, 400), bar(40, 420), bar(0, 440)],
    now: NOW,
  };

  it("notes a missing snapshot instead of presenting stale numbers as today's", () => {
    const m = buildReport({ ...base, snapshots: [snap(4, 5000), snap(3, 5100)] });
    expect(m.netLiq).toBe(5100);
    expect(m.notes[0]).toContain("today's did not log");
  });

  it("says when the benchmark is unavailable", () => {
    const m = buildReport({ ...base, benchmark: null, snapshots: [snap(1, 1), snap(0, 1)] });
    expect(m.notes.some((n) => n.includes("no market comparison"))).toBe(true);
    expect(m.returns.every((r) => r.benchmark == null)).toBe(true);
  });

  it("indexes both growth series to 100 at the first snapshot", () => {
    const m = buildReport({ ...base, snapshots: [snap(100, 4000), snap(40, 4400), snap(0, 5000)] });
    expect(m.growth[0]).toMatchObject({ book: 100, benchmark: 100 });
    expect(m.growth.at(-1)!.book).toBeCloseTo(125);
    expect(m.growth.at(-1)!.benchmark).toBeCloseTo(110);
  });

  it("renders a subject a reader can triage from", () => {
    const m = buildReport({ ...base, snapshots: [snap(100, 4000), snap(40, 4400), snap(0, 5000)] });
    const { subject, html, text } = renderEmail(m, { logo: "cid:logo", growth: "cid:growth" });
    expect(subject).toBe(
      "[Test Book] $5,000.00 · 1M +13.6% (SPY +4.8%) · 3M +25.0% (SPY +10.0%) · nothing to act on",
    );
    expect(html).toContain('src="cid:growth"');
    expect(html).toContain("Nothing needs a decision today.");
    expect(text).toContain("SUGGESTED ACTIONS (0)");
  });

  it("leaves an image out when no reference is given for it", () => {
    const m = buildReport({ ...base, snapshots: [snap(1, 1), snap(0, 1)] });
    expect(renderEmail(m).html).not.toContain("<img");
  });

  it("escapes names that reach the HTML", () => {
    const m = buildReport({
      ...base,
      portfolio: { ...base.portfolio, name: `<img src=x onerror="alert(1)">&co` },
      snapshots: [snap(1, 1), snap(0, 1)],
    });
    const html = renderEmail(m).html;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain(esc(`<img src=x onerror="alert(1)">&co`));
  });
});

describe("growthChartSvg", () => {
  it("draws both series and labels the benchmark", () => {
    const svg = growthChartSvg(
      [
        { ts: NOW.getTime() - 2 * DAY, book: 100, benchmark: 100 },
        { ts: NOW.getTime() - DAY, book: 104, benchmark: 101 },
        { ts: NOW.getTime(), book: 98, benchmark: 103 },
      ],
      "Test Book",
    )!;
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("SPY (total return)");
    expect(svg).toContain("Test Book");
  });

  it("escapes the series name into the SVG", () => {
    // The name is the portfolio's, typed by a user. Unescaped, it would make
    // the SVG unparseable at rasterising time, or carry markup into it.
    const svg = growthChartSvg(
      [
        { ts: NOW.getTime() - DAY, book: 100, benchmark: 100 },
        { ts: NOW.getTime(), book: 101, benchmark: 99 },
      ],
      `A & <B> <script>x</script>`,
    )!;
    expect(svg).not.toContain("<B>");
    expect(svg).not.toContain("<script>");
  });

  it("is null with nothing to draw", () => {
    expect(growthChartSvg([], "x")).toBeNull();
  });
});
