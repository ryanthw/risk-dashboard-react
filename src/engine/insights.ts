/**
 * Turn research output plus the live book into a short list of things worth
 * saying — and, more importantly, decline to say the rest.
 *
 * Every figure here rests on a handful of trades. Three months of a personal
 * book gives structures with n=1, and a page that renders "100% win rate" from
 * one closed trade is not informative, it is wrong in a way that reads as
 * authoritative. So each rule states the sample it rests on, and no rule fires
 * below its own threshold. A suppressed insight is the correct output, not a
 * gap to be filled.
 *
 * The sample thresholds are judgement calls, deliberately conservative, and
 * they are the first thing to revisit as the book grows.
 */
import {
  CREDIT_TYPES,
  TRADE_TYPE_LABELS,
  type BookStat,
  type Trade,
  type TradeType,
} from "@/types";
import { fmtUsd } from "@/lib/format";

/** Below this, a percentage is noise dressed as a measurement. Show counts. */
export const MIN_N_FOR_RATE = 5;
/** Below this, a structure gets no generated claim at all. */
export const MIN_N_FOR_CLAIM = 4;
/** A portfolio needs at least this many closed trades to characterise itself. */
export const MIN_N_FOR_PORTFOLIO_CLAIM = 10;
/** At or under this, holding something is "no track record", not "a small one". */
export const NO_RECORD_N = 2;
/** A structure must earn at least this share of realized P&L to carry a book... */
export const DOMINANT_MIN_PNL_SHARE = 0.4;
/** ...and that share must exceed its share of trades by this factor. */
export const DOMINANT_MIN_OVERWEIGHT = 1.5;
/** One trade at or above this share of a structure's P&L is worth naming. */
export const CONCENTRATION_SHARE = 0.4;

export type InsightTone = "positive" | "negative" | "neutral" | "unknown";

export interface Insight {
  id: string;
  tone: InsightTone;
  title: string;
  body: string;
  /** What the claim rests on. Always rendered — never a bare assertion. */
  basis: string;
  /** Tickers or positions the claim covers, for the chip row. */
  subjects: string[];
}

const label = (t: string) => TRADE_TYPE_LABELS[t as TradeType] ?? t;
const isCredit = (t: string) => CREDIT_TYPES.includes(t as TradeType);
const pairKey = (ticker: string, type: string) => `${ticker}|${type}`;

/** "APLD x3" per ticker, so a chip row summarises rather than enumerates. */
function tickerCounts(trades: Trade[]): string[] {
  const m = new Map<string, number>();
  for (const t of trades) m.set(t.ticker, (m.get(t.ticker) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tk, n]) => (n > 1 ? `${tk} ×${n}` : tk));
}
const pct = (x: number) => `${Math.round(x * 100)}%`;

function groupBy(trades: Trade[], key: (t: Trade) => string): Map<string, Trade[]> {
  const m = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = key(t);
    (m.get(k) ?? m.set(k, []).get(k)!).push(t);
  }
  return m;
}

/** A rate, or null when too few trades stand behind it to quote one. */
export function rateOrNull(value: number | null, n: number): number | null {
  return value != null && n >= MIN_N_FOR_RATE ? value : null;
}

/**
 * `stats` may be empty: a portfolio with open positions and nothing closed yet
 * has no research row at all, and that is exactly when "no track record" is
 * the most important thing to say. Portfolio-level claims need the portfolio
 * row; everything else runs on whatever is there.
 */
export function buildInsights(stats: BookStat[], open: Trade[]): Insight[] {
  const out: Insight[] = [];
  const portfolio = stats.find((s) => s.grain === "portfolio");
  const byStructure = stats.filter((s) => s.grain === "strategy");
  const byTicker = new Map(
    stats.filter((s) => s.grain === "ticker").map((s) => [s.ticker, s]),
  );
  const byPair = new Map(
    stats
      .filter((s) => s.grain === "ticker_strategy")
      .map((s) => [pairKey(s.ticker, s.trade_type), s]),
  );

  const openByType = groupBy(open, (t) => t.trade_type);
  const openByPair = groupBy(open, (t) => pairKey(t.ticker, t.trade_type));

  // ---- where the money actually came from --------------------------------
  // "Carrying" means out-earning its weight, not just being large: a structure
  // that is 60% of trades and 60% of P&L is the book's average, and naming it
  // would bury whatever actually is pulling ahead. The share-of-P&L claim is a
  // portfolio-level statement, so it is gated on the portfolio's sample; the
  // structure still needs enough trades of its own to be named at all.
  const totalPnl = portfolio?.total_pnl ?? 0;
  if (portfolio && portfolio.n_pnl >= MIN_N_FOR_PORTFOLIO_CLAIM && totalPnl > 0) {
    const top = byStructure
      .filter((s) => s.n_pnl >= MIN_N_FOR_CLAIM && (s.total_pnl ?? 0) > 0)
      .map((s) => ({
        s,
        share: (s.total_pnl ?? 0) / totalPnl,
        tradeShare: s.n_pnl / portfolio.n_pnl,
      }))
      .filter(
        (x) =>
          x.share >= DOMINANT_MIN_PNL_SHARE &&
          x.share >= DOMINANT_MIN_OVERWEIGHT * x.tradeShare,
      )
      .sort((a, b) => (b.s.total_pnl ?? 0) - (a.s.total_pnl ?? 0))[0];
    if (top) {
      const { s, share, tradeShare } = top;
      const pnl = s.total_pnl ?? 0;
      const held = openByType.get(s.trade_type) ?? [];
      const trades = `${pct(tradeShare)} of trades (${s.n_pnl} of ${portfolio.n_pnl})`;
      // Over 100% when the rest of the book lost money. "140% of P&L" is true
      // arithmetic and useless prose, so say what actually happened.
      const head =
        share > 1
          ? `More than all realized P&L — ${fmtUsd(pnl)} from ${trades}, ` +
            `while the rest of the book netted ${fmtUsd(totalPnl - pnl)}.`
          : `${pct(share)} of realized P&L from ${trades}, ${fmtUsd(pnl)} total.`;
      // A structure carried by one trade is a different finding from one
      // carried by many, and the reader cannot tell them apart from the total.
      const best = s.best_pnl ?? 0;
      const concentrated =
        best > 0 && best / pnl >= CONCENTRATION_SHARE
          ? ` The best single trade, ${fmtUsd(best)}, is ${pct(best / pnl)} of that.`
          : "";
      out.push({
        id: `dominant-${s.trade_type}`,
        tone: "positive",
        title: `${label(s.trade_type)}s are carrying this book`,
        body:
          head +
          concentrated +
          (held.length ? ` Now ${held.length} of ${open.length} open positions.` : ""),
        basis: `${s.n_wins} of ${s.n_pnl} profitable`,
        subjects: tickerCounts(held),
      });
    }
  }

  // ---- structures that have lost money -----------------------------------
  for (const s of byStructure) {
    if ((s.total_pnl ?? 0) >= 0 || s.n_pnl < MIN_N_FOR_CLAIM) continue;
    const held = openByType.get(s.trade_type) ?? [];
    const rate = rateOrNull(s.win_rate, s.n_pnl);
    out.push({
      id: `losing-${s.trade_type}`,
      tone: held.length ? "negative" : "neutral",
      title: held.length
        ? `${label(s.trade_type)}s have not worked here — and you hold ${held.length}`
        : // "Never" only when it is literally true: net-negative with some
          // winners is a losing structure, not one that has never paid.
          s.n_wins === 0
          ? `${label(s.trade_type)}s never worked here`
          : `${label(s.trade_type)}s have lost money here`,
      body:
        `${s.n_wins} of ${s.n_pnl} profitable, ${fmtUsd(s.total_pnl)} total` +
        (s.mean_ror != null && s.n_ror >= MIN_N_FOR_RATE
          ? `, ${pct(s.mean_ror)} mean return on risk.`
          : ".") +
        (held.length ? "" : " You hold none."),
      // The rate is quoted only when enough trades stand behind it; otherwise
      // the counts above already said everything that can honestly be said.
      basis: rate != null ? `win rate ${pct(rate)} over ${s.n_pnl}` : `${s.n_pnl} closed`,
      subjects: tickerCounts(held),
    });
  }

  // ---- exposure with no track record --------------------------------------
  // Judged per ticker *and* structure for options: a run of covered calls on a
  // name says nothing about buying calls on it, and checking the ticker alone
  // let every new structure on a familiar name pass as having a record. A share
  // lot is judged by the name — owning shares you were assigned on is the same
  // bet the puts made, not a new one.
  const gaps = [...openByPair.values()]
    .map((held) => {
      const { ticker, trade_type } = held[0];
      const tickerN = byTicker.get(ticker)?.n_pnl ?? 0;
      const closed =
        trade_type === "shares"
          ? tickerN
          : (byPair.get(pairKey(ticker, trade_type))?.n_pnl ?? 0);
      return { ticker, type: trade_type, held: held.length, closed, elsewhere: tickerN - closed };
    })
    .filter((g) => g.closed <= NO_RECORD_N)
    .sort((a, b) => b.held - a.held || a.ticker.localeCompare(b.ticker));
  if (gaps.length) {
    const positions = gaps.reduce((n, g) => n + g.held, 0);
    const familiar = gaps.filter((g) => g.elsewhere > 0).length;
    const name = (g: (typeof gaps)[number]) => `${g.ticker} ${label(g.type)}`;
    out.push({
      id: "no-record",
      tone: "unknown",
      title:
        positions === 1
          ? `${name(gaps[0])} — no track record`
          : `${positions} open positions with no track record`,
      body:
        `Open in ticker and structure pairs this portfolio has closed ${NO_RECORD_N} ` +
        "or fewer of. Nothing here to compare them against yet." +
        (familiar
          ? ` ${familiar === gaps.length ? "All" : `${familiar} of ${gaps.length}`} ` +
            "are names traded before, but in a different structure."
          : ""),
      basis: gaps.map((g) => `${name(g)} ${g.closed} closed`).join(" · "),
      subjects: gaps.map((g) => (g.held > 1 ? `${name(g)} ×${g.held}` : name(g))),
    });
  }

  // ---- structures you have stopped using ----------------------------------
  // Skipped where the structure already headlines above: two adjacent cards
  // about the same structure read as a bug, not as two findings.
  const headlined = new Set(out.map((i) => i.id.split("-").slice(1).join("-")));
  for (const s of byStructure) {
    if (headlined.has(s.trade_type)) continue;
    if ((openByType.get(s.trade_type) ?? []).length > 0) continue;
    if (s.n_pnl < MIN_N_FOR_RATE || (s.total_pnl ?? 0) <= 0) continue;
    out.push({
      id: `dormant-${s.trade_type}`,
      tone: "neutral",
      title: `No ${label(s.trade_type)}s open, though they have worked`,
      body: `${s.n_wins} of ${s.n_pnl} profitable, ${fmtUsd(s.total_pnl)} total. None currently held.`,
      basis: `${s.n_pnl} closed · last ${s.last_exit?.slice(0, 10) ?? "—"}`,
      subjects: [],
    });
  }

  // ---- measurement gaps, stated rather than hidden -------------------------
  // A structure with trades but no capital-at-risk denominator cannot be
  // compared on return. Once enough of them close with their entry detail,
  // return on premium stands in and the execution card below reports it — so
  // only a structure with neither measure is a gap worth stating.
  const noRor = byStructure.filter(
    (s) =>
      s.n_pnl >= MIN_N_FOR_CLAIM &&
      s.n_ror === 0 &&
      s.n_return_on_premium < MIN_N_FOR_RATE &&
      (openByType.get(s.trade_type) ?? []).length > 0,
  );
  if (noRor.length) {
    out.push({
      id: "no-ror",
      tone: "unknown",
      title: "No return-on-capital measure for part of this book",
      body:
        `${noRor.map((s) => label(s.trade_type) + "s").join(" and ")} carry no max-loss figure — ` +
        "for covered calls the risk sits with the covering shares, and a naked call's is unbounded. " +
        `Return on premium stands in once ${MIN_N_FOR_RATE} have closed with their entry detail recorded.`,
      basis: noRor
        .map((s) => `${label(s.trade_type)} ${s.n_pnl} closed, ${s.n_return_on_premium} with entry detail`)
        .join(" · "),
      subjects: [],
    });
  }

  // ---- how each structure has actually been run ----------------------------
  // Only trades archived after migration 0011 carry exit path, premium, DTE
  // and strike, so each clause is gated on its own count, never on n. Measures
  // whose subset the stats table does not count separately (IV versus ATM, IV
  // change, underlying move, share of DTE held) are left out rather than
  // quoted against a count that is merely close.
  for (const s of byStructure) {
    const clauses: string[] = [];
    if (s.n_exit_path >= MIN_N_FOR_RATE) {
      const paths = (
        [
          ["closed early", s.rate_closed_early],
          ["expired", s.rate_expired],
          ["assigned", s.rate_assigned],
          ["called away", s.rate_called_away],
        ] as const
      )
        .filter(([, r]) => r != null && r > 0)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .map(([p, r]) => `${p} ${pct(r!)}`);
      if (paths.length) clauses.push(`Ended ${paths.join(", ")} (${s.n_exit_path} recorded).`);
    }
    // For a credit structure this is also the share of max gain captured: its
    // best case is the credit. Debit structures already have return on risk.
    if (
      isCredit(s.trade_type) &&
      s.n_return_on_premium >= MIN_N_FOR_RATE &&
      s.mean_return_on_premium != null
    ) {
      clauses.push(
        `Kept ${pct(s.mean_return_on_premium)} of the premium on average (${s.n_return_on_premium}).`,
      );
    }
    if (s.n_dte >= MIN_N_FOR_RATE && s.mean_dte_at_entry != null) {
      clauses.push(`Opened at ${Math.round(s.mean_dte_at_entry)} DTE on average (${s.n_dte}).`);
    }
    if (s.n_itm >= MIN_N_FOR_RATE && s.rate_finished_itm != null) {
      clauses.push(`Finished in the money ${pct(s.rate_finished_itm)} of the time (${s.n_itm}).`);
    }
    if (!clauses.length) continue;
    out.push({
      id: `execution-${s.trade_type}`,
      tone: "neutral",
      title: `How ${label(s.trade_type)}s have been run`,
      body: clauses.join(" "),
      basis: `${s.n_full} of ${s.n_pnl} closed with entry detail`,
      subjects: tickerCounts(openByType.get(s.trade_type) ?? []),
    });
  }

  // Held-and-losing first, then unknowns, then the rest.
  const order: Record<InsightTone, number> = { negative: 0, unknown: 1, positive: 2, neutral: 3 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}
