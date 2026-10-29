import { describe, expect, it } from "vitest";
import { buildReport, windowReturn } from "@/report/portfolioReport";
import { renderEmail } from "@/report/renderEmail";
import type { CashFlow, Portfolio, Snapshot } from "@/types";

// Synthetic fixtures: this repo is public and the real book is not.

const DAY = 86_400_000;
const NOW = new Date("2026-06-30T22:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

const snap = (daysAgo: number, net_liquidity: number) =>
  ({ id: `s${daysAgo}`, ts: ago(daysAgo), net_liquidity }) as Snapshot;
const flow = (daysAgo: number, amount: number, kind: CashFlow["kind"] = "deposit") =>
  ({ id: `f${daysAgo}`, ts: ago(daysAgo), amount, kind }) as CashFlow;

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
  });

  it("measures from the last snapshot at or before the window start", () => {
    const r = windowReturn([snap(50, 900), snap(35, 1000), snap(10, 1050), snap(0, 1100)], [], 30, "1M");
    expect(r.from).toBe(ago(35));
    expect(r.ret).toBeCloseTo(0.1);
  });
});

describe("buildReport", () => {
  const base = {
    portfolio: { id: "p", name: "Test Book", cash: 5000 } as Portfolio,
    trades: [],
    cashFlows: [],
    stats: [],
    closed: [],
    now: NOW,
  };

  it("notes a missing snapshot instead of presenting stale numbers as today's", () => {
    const m = buildReport({ ...base, snapshots: [snap(4, 5000), snap(3, 5100)] });
    expect(m.netLiq).toBe(5100);
    expect(m.notes[0]).toContain("today's did not log");
  });

  it("renders a subject a reader can triage from", () => {
    const m = buildReport({ ...base, snapshots: [snap(100, 4000), snap(40, 4400), snap(0, 5000)] });
    const { subject, html, text } = renderEmail(m);
    expect(subject).toBe("[Test Book] $5,000.00 · 1M +13.6% · 3M +25.0% · nothing to act on");
    expect(html).toContain("Nothing needs a decision today.");
    expect(text).toContain("SUGGESTED ACTIONS (0)");
  });

  it("escapes names that reach the HTML", () => {
    const m = buildReport({
      ...base,
      portfolio: { ...base.portfolio, name: "<b>&co" },
      snapshots: [snap(1, 1), snap(0, 1)],
    });
    expect(renderEmail(m).html).toContain("&lt;b&gt;&amp;co");
  });
});
