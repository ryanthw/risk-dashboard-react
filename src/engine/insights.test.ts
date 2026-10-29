import { describe, expect, it } from "vitest";
import { buildInsights, NO_RECORD_N } from "@/engine/insights";
import type { BookStat, StatGrain, Trade, TradeType } from "@/types";

// Fixtures are synthetic. This repo is public and research_book_stats is a
// personal trading record, so the shapes here mirror real cases the engine got
// wrong without carrying anyone's actual tickers or P&L.

function stat(grain: StatGrain, over: Partial<BookStat> = {}): BookStat {
  return {
    portfolio_id: "p1", grain, ticker: "", trade_type: "", portfolio_name: "Test",
    n: 0, n_full: 0, n_pnl: 0, n_wins: 0,
    win_rate: null, total_pnl: null, mean_pnl: null, median_pnl: null,
    best_pnl: null, worst_pnl: null, profit_factor: null, expectancy: null,
    n_ror: 0, mean_ror: null, median_ror: null, mean_ann_ror: null,
    n_return_on_premium: 0, mean_return_on_premium: null, mean_pct_max_gain_captured: null,
    mean_hold_days: null, median_hold_days: null,
    n_dte: 0, mean_dte_at_entry: null, mean_dte_held_pct: null,
    n_moneyness: 0, mean_moneyness_at_entry: null,
    n_premium_yield: 0, mean_premium_yield_ann: null,
    n_iv: 0, mean_iv_at_open: null, mean_iv_vs_atm_at_open: null, mean_iv_change_pct: null,
    n_exit_path: 0, rate_expired: null, rate_assigned: null, rate_called_away: null,
    rate_closed_early: null, n_itm: 0, rate_finished_itm: null, rate_move_favored: null,
    mean_underlying_move_pct: null, first_exit: null, last_exit: null, as_of: "2026-01-01",
    ...over,
  };
}

const portfolio = (n_pnl: number, total_pnl: number) =>
  stat("portfolio", { n: n_pnl, n_pnl, total_pnl });

const structure = (trade_type: TradeType, over: Partial<BookStat>) =>
  stat("strategy", { trade_type, n: over.n_pnl ?? 0, ...over });

const pair = (ticker: string, trade_type: TradeType, n_pnl: number) =>
  stat("ticker_strategy", { ticker, trade_type, n: n_pnl, n_pnl });

const ticker = (t: string, n_pnl: number) => stat("ticker", { ticker: t, n: n_pnl, n_pnl });

let seq = 0;
function open(ticker: string, trade_type: TradeType, count = 1): Trade[] {
  return Array.from({ length: count }, () => ({ id: `t${++seq}`, ticker, trade_type }) as Trade);
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("dominant structure", () => {
  it("does not credit a structure that only earns its share of trades", () => {
    // 60% of trades, 58% of P&L: the book's average, not what is carrying it.
    const out = buildInsights(
      [
        portfolio(100, 1000),
        structure("cc", { n_pnl: 60, n_wins: 48, total_pnl: 580 }),
        structure("long_call", { n_pnl: 10, n_wins: 8, total_pnl: 400, best_pnl: 100 }),
      ],
      [],
    );
    expect(ids(out)).not.toContain("dominant-cc");
    expect(ids(out)).toContain("dominant-long_call");
  });

  it("names a single trade that makes up most of the structure's P&L", () => {
    const out = buildInsights(
      [
        portfolio(100, 1000),
        structure("long_call", { n_pnl: 10, n_wins: 8, total_pnl: 500, best_pnl: 250 }),
      ],
      [],
    );
    const d = out.find((i) => i.id === "dominant-long_call")!;
    expect(d.body).toContain("best single trade");
    expect(d.body).toContain("50%");
  });

  it("says 'more than all' instead of quoting a share over 100%", () => {
    const out = buildInsights(
      [
        portfolio(20, 200),
        structure("csp", { n_pnl: 6, n_wins: 6, total_pnl: 300 }),
        structure("pcs", { n_pnl: 14, n_wins: 3, total_pnl: -100 }),
      ],
      [],
    );
    const d = out.find((i) => i.id === "dominant-csp")!;
    expect(d.body).toMatch(/^More than all realized P&L/);
    expect(d.body).not.toContain("150%");
  });

  it("needs enough trades in the structure, not just in the portfolio", () => {
    const out = buildInsights(
      [portfolio(50, 1000), structure("long_call", { n_pnl: 3, n_wins: 3, total_pnl: 800 })],
      [],
    );
    expect(ids(out)).not.toContain("dominant-long_call");
  });
});

describe("track record", () => {
  it("flags a structure new to a ticker even when the ticker has history", () => {
    const out = buildInsights(
      [portfolio(20, 100), ticker("AAA", 8), pair("AAA", "cc", 8)],
      [...open("AAA", "cc"), ...open("AAA", "long_call", 3)],
    );
    const gap = out.find((i) => i.id === "no-record")!;
    expect(gap.subjects).toEqual(["AAA Long Call ×3"]);
    expect(gap.basis).toBe("AAA Long Call 0 closed");
    expect(gap.body).toContain("different structure");
  });

  it("treats more than NO_RECORD_N closed trades in the pair as a record", () => {
    const out = buildInsights(
      [portfolio(20, 100), ticker("AAA", NO_RECORD_N + 1), pair("AAA", "csp", NO_RECORD_N + 1)],
      open("AAA", "csp"),
    );
    expect(ids(out)).not.toContain("no-record");
  });

  it("judges shares by the ticker, not the pair", () => {
    // Assigned shares on a name with a put history are not a new bet; a name
    // never traded at all is.
    const out = buildInsights(
      [portfolio(20, 100), ticker("AAA", 6), pair("AAA", "csp", 6)],
      [...open("AAA", "shares"), ...open("BBB", "shares")],
    );
    const gap = out.find((i) => i.id === "no-record")!;
    expect(gap.subjects).toEqual(["BBB Long Equity"]);
  });
});

describe("portfolio with nothing closed", () => {
  it("still reports open positions as having no track record", () => {
    const out = buildInsights([], [...open("AAA", "csp"), ...open("BBB", "csp")]);
    expect(ids(out)).toEqual(["no-record"]);
    expect(out[0].title).toBe("2 open positions with no track record");
  });

  it("says nothing when there is nothing closed and nothing open", () => {
    expect(buildInsights([], [])).toEqual([]);
  });
});

describe("return on premium", () => {
  it("does not call a structure unmeasured once return on premium covers it", () => {
    const out = buildInsights(
      [
        portfolio(20, 100),
        structure("cc", {
          n_pnl: 20, n_wins: 18, total_pnl: 100,
          n_return_on_premium: 8, mean_return_on_premium: 0.6,
        }),
      ],
      open("AAA", "cc"),
    );
    expect(ids(out)).not.toContain("no-ror");
    expect(out.find((i) => i.id === "execution-cc")!.body).toContain(
      "Kept 60% of the premium on average (8).",
    );
  });

  it("still states the gap while too few carry entry detail", () => {
    const out = buildInsights(
      [
        portfolio(20, 100),
        structure("cc", { n_pnl: 20, n_wins: 18, total_pnl: 100, n_return_on_premium: 2 }),
      ],
      open("AAA", "cc"),
    );
    const gap = out.find((i) => i.id === "no-ror")!;
    expect(gap.basis).toBe("Covered Call 20 closed, 2 with entry detail");
  });
});

describe("execution detail", () => {
  it("gates each clause on its own count", () => {
    const out = buildInsights(
      [
        portfolio(30, 500),
        structure("cc", {
          n_pnl: 30, n_full: 10, n_wins: 25, total_pnl: 500,
          n_exit_path: 10, rate_closed_early: 0.8, rate_expired: 0.2, rate_assigned: 0,
          n_return_on_premium: 10, mean_return_on_premium: 0.5,
          n_dte: 10, mean_dte_at_entry: 38.6,
          // Too few to quote: must not appear.
          n_itm: 3, rate_finished_itm: 0.33,
        }),
      ],
      [],
    );
    const e = out.find((i) => i.id === "execution-cc")!;
    expect(e.body).toBe(
      "Ended closed early 80%, expired 20% (10 recorded). " +
        "Kept 50% of the premium on average (10). " +
        "Opened at 39 DTE on average (10).",
    );
    expect(e.basis).toBe("10 of 30 closed with entry detail");
  });

  it("does not report premium kept for a debit structure", () => {
    const out = buildInsights(
      [
        portfolio(30, 500),
        structure("long_call", {
          n_pnl: 10, n_wins: 6, total_pnl: 50,
          n_return_on_premium: 6, mean_return_on_premium: 0.2,
        }),
      ],
      [],
    );
    expect(ids(out)).not.toContain("execution-long_call");
  });

  it("stays silent while the entry-detail sample is small", () => {
    const out = buildInsights(
      [
        portfolio(30, 500),
        structure("csp", {
          n_pnl: 30, n_wins: 25, total_pnl: 500,
          n_exit_path: 4, rate_closed_early: 1, n_dte: 4, mean_dte_at_entry: 30,
        }),
      ],
      [],
    );
    expect(ids(out)).not.toContain("execution-csp");
  });
});

describe("losing structures", () => {
  it("only says 'never worked' when nothing ever won", () => {
    const out = buildInsights(
      [
        portfolio(20, 100),
        structure("pcs", { n_pnl: 4, n_wins: 0, total_pnl: -50 }),
        structure("cds", { n_pnl: 6, n_wins: 2, total_pnl: -80 }),
      ],
      [],
    );
    expect(out.find((i) => i.id === "losing-pcs")!.title).toBe("Put Credit Spreads never worked here");
    expect(out.find((i) => i.id === "losing-cds")!.title).toBe("Call Debit Spreads have lost money here");
  });

  it("puts a held losing structure first", () => {
    const out = buildInsights(
      [
        portfolio(30, 500),
        structure("csp", { n_pnl: 20, n_wins: 18, total_pnl: 600 }),
        structure("pcs", { n_pnl: 10, n_wins: 3, total_pnl: -100 }),
      ],
      open("AAA", "pcs"),
    );
    expect(out[0].id).toBe("losing-pcs");
    expect(out[0].tone).toBe("negative");
  });
});
