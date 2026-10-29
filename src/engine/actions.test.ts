import { describe, expect, it } from "vitest";
import {
  CONCENTRATION_PCT,
  DEFAULT_TAKE_PROFIT,
  modelMark,
  suggestActions,
} from "@/engine/actions";
import type { Position } from "@/engine/portfolio";
import { deriveTradeMetrics } from "@/engine/trade";
import type { BookStat, Trade, TradeType } from "@/types";

// Synthetic fixtures: this repo is public and the real book is not.

const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);

let seq = 0;
function pos(over: Partial<Trade> & { trade_type: TradeType; ticker: string }): Position {
  const trade = {
    id: `t${++seq}`,
    user_id: "u",
    portfolio_id: "p",
    qty: 1,
    strike: null,
    strike_2: null,
    premium: null,
    iv: 0.5,
    expiration: null,
    underlying_price: 100,
    cost_basis: null,
    sector: "",
    beta: 1,
    iv_at_open: null,
    atm_iv_at_open: null,
    underlying_at_open: null,
    iv_skew_ratio: null,
    iv_source: "contract",
    iv_updated_at: null,
    opened_at: new Date(Date.now() - 30 * DAY).toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  } as Trade;
  // Few sims: these tests read marks and rules, not the distribution.
  return { trade, metrics: deriveTradeMetrics(trade, 200) };
}

function stat(trade_type: TradeType, over: Partial<BookStat>): BookStat {
  return { grain: "strategy", trade_type, ticker: "", n_return_on_premium: 0, ...over } as BookStat;
}

const BIG = 1_000_000; // net liq large enough that concentration never fires by accident
const titles = (ps: Position[], stats: BookStat[] = [], netLiq = BIG) =>
  suggestActions(ps, stats, netLiq).map((a) => a.title);

describe("modelMark", () => {
  it("reports share of max profit captured for short premium", () => {
    // Far OTM put near expiry: almost worthless, so nearly all the credit is kept.
    const m = modelMark(pos({ trade_type: "csp", ticker: "AAA", strike: 50, premium: 2, expiration: inDays(10) }))!;
    expect(m.mark).toBeLessThan(0.01);
    expect(m.pnlPct).toBeGreaterThan(0.99);
    expect(m.pnl).toBeGreaterThan(199);
  });

  it("marks shares against their cost basis", () => {
    const m = modelMark(pos({ trade_type: "shares", ticker: "AAA", qty: 10, cost_basis: 80 }))!;
    expect(m.pnl).toBe(200);
    expect(m.pnlPct).toBeCloseTo(0.25);
  });

  it("returns null when there is no entry to compare against", () => {
    expect(modelMark(pos({ trade_type: "shares", ticker: "AAA" }))).toBeNull();
  });
});

describe("suggestActions", () => {
  it("flags covered calls that outlast their cover", () => {
    const out = suggestActions(
      [
        pos({ trade_type: "cc", ticker: "AAA", qty: 2, strike: 130, premium: 1, expiration: inDays(60) }),
        // Covers one contract for the full term; the second long call lapses first.
        pos({ trade_type: "long_call", ticker: "AAA", strike: 80, premium: 25, expiration: inDays(400) }),
        pos({ trade_type: "long_call", ticker: "AAA", strike: 80, premium: 22, expiration: inDays(30) }),
      ],
      [],
      BIG,
    );
    expect(out[0]).toMatchObject({ priority: "high", title: "AAA: 1 covered call without cover" });
  });

  it("counts 100 shares as cover for one call", () => {
    const t = titles([
      pos({ trade_type: "cc", ticker: "AAA", strike: 130, premium: 1, expiration: inDays(60) }),
      pos({ trade_type: "shares", ticker: "AAA", qty: 100, cost_basis: 90 }),
    ]);
    expect(t.some((x) => x.includes("without cover"))).toBe(false);
  });

  it("makes an in-the-money short put expiring this week high priority", () => {
    const out = suggestActions(
      [pos({ trade_type: "csp", ticker: "AAA", strike: 110, premium: 3, expiration: inDays(3) })],
      [],
      BIG,
    );
    expect(out).toHaveLength(1); // ITM wins; no second card for "expiring"
    expect(out[0].priority).toBe("high");
    expect(out[0].title).toContain("in the money");
  });

  it("takes profit at the book's own average when enough trades record it", () => {
    const p = pos({ trade_type: "csp", ticker: "AAA", strike: 70, premium: 1, expiration: inDays(30) });
    const captured = modelMark(p)!.pnlPct!;
    const ownTarget = stat("csp", { n_return_on_premium: 8, mean_return_on_premium: captured - 0.05 });
    const out = suggestActions([p], [ownTarget], BIG);
    expect(out[0].title).toContain("of max profit captured");
    expect(out[0].detail).toContain("your Cash-Secured Puts have kept");
  });

  it("falls back to the default target when the book's sample is too small", () => {
    const p = pos({ trade_type: "csp", ticker: "AAA", strike: 70, premium: 1, expiration: inDays(30) });
    expect(modelMark(p)!.pnlPct!).toBeGreaterThan(DEFAULT_TAKE_PROFIT);
    const thin = stat("csp", { n_return_on_premium: 2, mean_return_on_premium: 0.99 });
    expect(suggestActions([p], [thin], BIG)[0].detail).toContain("standard 50%");
  });

  it("flags out-of-the-money long options inside the decay window only", () => {
    const t = titles([
      pos({ trade_type: "long_call", ticker: "AAA", strike: 120, premium: 2, expiration: inDays(15) }),
      pos({ trade_type: "long_call", ticker: "BBB", strike: 120, premium: 2, expiration: inDays(90) }),
      pos({ trade_type: "long_call", ticker: "CCC", strike: 80, premium: 22, expiration: inDays(15) }),
    ]);
    expect(t).toEqual(["AAA Long Call $120.00: out of the money with 14d left"]);
  });

  it("watches a credit spread's short strike once it is close", () => {
    const out = suggestActions(
      [pos({ trade_type: "pcs", ticker: "AAA", strike: 98, strike_2: 93, premium: 1, expiration: inDays(40) })],
      [],
      BIG,
    );
    expect(out[0]).toMatchObject({ priority: "low" });
    expect(out[0].title).toBe("AAA Put Credit Spread is 2.0% from its short strike");
  });

  it("calls out one ticker carrying too much of net liquidity", () => {
    const ps = [pos({ trade_type: "long_call", ticker: "AAA", strike: 90, premium: 30, expiration: inDays(300) })];
    // $3,000 max loss on $10,000 is 30%.
    expect(titles(ps, [], 10_000)).toContain("AAA carries 30% of net liquidity at risk");
    // Just under the threshold on a larger book: nothing.
    expect(titles(ps, [], (3000 / (CONCENTRATION_PCT - 1)) * 100)).toEqual([]);
  });

  it("flags every ticker over the concentration line, not just the largest", () => {
    const ps = [
      pos({ trade_type: "long_call", ticker: "AAA", strike: 90, premium: 40, expiration: inDays(300) }),
      pos({ trade_type: "long_call", ticker: "BBB", strike: 90, premium: 30, expiration: inDays(300) }),
      pos({ trade_type: "long_call", ticker: "CCC", strike: 90, premium: 5, expiration: inDays(300) }),
    ];
    expect(titles(ps, [], 10_000)).toEqual([
      "AAA carries 40% of net liquidity at risk",
      "BBB carries 30% of net liquidity at risk",
    ]);
  });

  it("orders high before medium before low", () => {
    const out = suggestActions(
      [
        pos({ trade_type: "pcs", ticker: "AAA", strike: 98, strike_2: 93, premium: 1, expiration: inDays(40) }),
        pos({ trade_type: "short_call", ticker: "BBB", strike: 120, premium: 1, expiration: inDays(40) }),
        pos({ trade_type: "long_call", ticker: "CCC", strike: 120, premium: 2, expiration: inDays(15) }),
      ],
      [],
      BIG,
    );
    expect(out.map((a) => a.priority)).toEqual(["high", "medium", "low"]);
  });
});
