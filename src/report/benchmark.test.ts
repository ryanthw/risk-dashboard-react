import { describe, expect, it } from "vitest";
import { benchmarkReturn, closeAt, parseYahooChart } from "@/report/benchmark";

// Yahoo stamps a daily bar at the 09:30 ET open (13:30 UTC in summer).
const open = (date: string) => Date.parse(`${date}T13:30:00Z`) / 1000;
const chart = (rows: [string, number | null][]) => ({
  chart: {
    result: [
      {
        timestamp: rows.map(([d]) => open(d)),
        indicators: { adjclose: [{ adjclose: rows.map(([, c]) => c) }] },
      },
    ],
  },
});

describe("parseYahooChart", () => {
  it("keys bars by when the close printed and drops unusable prices", () => {
    const bars = parseYahooChart(
      chart([["2026-06-01", 500], ["2026-06-02", null], ["2026-06-03", -1], ["2026-06-04", 510]]),
    );
    expect(bars.map((b) => b.close)).toEqual([500, 510]);
    expect(new Date(bars[0].closeTs).toISOString()).toBe("2026-06-01T20:00:00.000Z");
  });

  it("returns nothing, rather than throwing, on an unexpected shape", () => {
    expect(parseYahooChart(null)).toEqual([]);
    expect(parseYahooChart({ chart: { result: [{ timestamp: "x" }] } })).toEqual([]);
    expect(parseYahooChart({ chart: { error: { code: "Not Found" } } })).toEqual([]);
    // Mismatched arrays cannot be aligned safely.
    expect(
      parseYahooChart({ chart: { result: [{ timestamp: [1, 2], indicators: { adjclose: [{ adjclose: [1] }] } }] } }),
    ).toEqual([]);
  });
});

describe("alignment to snapshot times", () => {
  const bars = parseYahooChart(
    chart([["2026-06-01", 500], ["2026-06-02", 505], ["2026-06-03", 510]]),
  );

  it("uses the previous close for a snapshot taken mid-session", () => {
    // Noon ET on the 2nd: the 2nd's close has not printed yet.
    expect(closeAt(bars, Date.parse("2026-06-02T16:00:00Z"))).toBe(500);
  });

  it("uses that day's close for a snapshot taken after it", () => {
    // 00:55 UTC on the 3rd is the evening of the 2nd in New York.
    expect(closeAt(bars, Date.parse("2026-06-03T00:55:00Z"))).toBe(505);
  });

  it("is null before the first close", () => {
    expect(closeAt(bars, Date.parse("2026-05-30T00:00:00Z"))).toBeNull();
  });

  it("measures the return between the two aligned closes", () => {
    expect(
      benchmarkReturn(bars, Date.parse("2026-06-02T01:00:00Z"), Date.parse("2026-06-04T01:00:00Z")),
    ).toBeCloseTo(510 / 500 - 1);
  });
});
