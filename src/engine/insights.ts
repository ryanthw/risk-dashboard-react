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
import { TRADE_TYPE_LABELS, type BookStat, type Trade, type TradeType } from "@/types";
import { fmtUsd } from "@/lib/format";

/** Below this, a percentage is noise dressed as a measurement. Show counts. */
export const MIN_N_FOR_RATE = 5;
/** Below this, a structure gets no generated claim at all. */
export const MIN_N_FOR_CLAIM = 4;
/** A portfolio needs at least this many closed trades to characterise itself. */
export const MIN_N_FOR_PORTFOLIO_CLAIM = 10;
/** At or under this, holding something is "no track record", not "a small one". */
export const NO_RECORD_N = 2;

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

/** "APLD x3" per ticker, so a chip row summarises rather than enumerates. */
function tickerCounts(trades: Trade[]): string[] {
  const m = new Map<string, number>();
  for (const t of trades) m.set(t.ticker, (m.get(t.ticker) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tk, n]) => (n > 1 ? `${tk} \u00d7${n}` : tk));
}
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A rate, or null when too few trades stand behind it to quote one. */
export function rateOrNull(value: number | null, n: number): number | null {
  return value != null && n >= MIN_N_FOR_RATE ? value : null;
}

export function buildInsights(stats: BookStat[], open: Trade[]): Insight[] {
  const out: Insight[] = [];
  const portfolio = stats.find((s) => s.grain === "portfolio");
  const byStructure = stats.filter((s) => s.grain === "strategy");
  const byTicker = stats.filter((s) => s.grain === "ticker");
  if (!portfolio) return out;

  const openByType = new Map<string, Trade[]>();
  const openByTicker = new Map<string, Trade[]>();
  for (const t of open) {
    (openByType.get(t.trade_type) ?? openByType.set(t.trade_type, []).get(t.trade_type)!).push(t);
    (openByTicker.get(t.ticker) ?? openByTicker.set(t.ticker, []).get(t.ticker)!).push(t);
  }

  const totalPnl = portfolio.total_pnl ?? 0;
  const bigEnough = portfolio.n_pnl >= MIN_N_FOR_PORTFOLIO_CLAIM;

  // ---- where the money actually came from --------------------------------
  // A share-of-P&L claim is a portfolio-level statement, so it is gated on the
  // portfolio's sample rather than the structure's — the structure's own n goes
  // in the basis line so the reader can weigh it.
  if (bigEnough && totalPnl > 0) {
    const top = [...byStructure]
      .filter((s) => (s.total_pnl ?? 0) > 0)
      .sort((a, b) => (b.total_pnl ?? 0) - (a.total_pnl ?? 0))[0];
    if (top && (top.total_pnl ?? 0) / totalPnl >= 0.4) {
      const share = (top.total_pnl ?? 0) / totalPnl;
      const tradeShare = top.n_pnl / portfolio.n_pnl;
      const held = openByType.get(top.trade_type) ?? [];
      out.push({
        id: `dominant-${top.trade_type}`,
        tone: "positive",
        title: `${label(top.trade_type)}s are carrying this book`,
        body:
          `${pct(share)} of realized P&L from ${pct(tradeShare)} of trades ` +
          `(${top.n_pnl} of ${portfolio.n_pnl}), ${fmtUsd(top.total_pnl)} total.` +
          (held.length ? ` Now ${held.length} of ${open.length} open positions.` : ""),
        basis: `${top.n_wins} of ${top.n_pnl} profitable`,
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
        : `${label(s.trade_type)}s never worked here`,
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
  const unknownTickers = [...openByTicker.keys()].filter((tk) => {
    const s = byTicker.find((x) => x.ticker === tk);
    return !s || s.n_pnl <= NO_RECORD_N;
  });
  if (unknownTickers.length) {
    out.push({
      id: "no-record-tickers",
      tone: "unknown",
      title:
        unknownTickers.length === 1
          ? `${unknownTickers[0]} — no track record`
          : `${unknownTickers.length} holdings with no track record`,
      body:
        "Open positions in names this portfolio has closed " +
        `${NO_RECORD_N} or fewer trades in. Nothing here to compare them against yet.`,
      basis: unknownTickers
        .map((tk) => {
          const s = byTicker.find((x) => x.ticker === tk);
          const n = s?.n_pnl ?? 0;
          return `${tk} (${n} closed)`;
        })
        .join(" · "),
      subjects: unknownTickers,
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
  // compared on return. Saying so is more useful than an empty cell.
  const noRor = byStructure.filter(
    (s) => s.n_pnl >= MIN_N_FOR_CLAIM && s.n_ror === 0 && (openByType.get(s.trade_type) ?? []).length > 0,
  );
  if (noRor.length) {
    out.push({
      id: "no-ror",
      tone: "unknown",
      title: "No return-on-capital measure for part of this book",
      body:
        `${noRor.map((s) => label(s.trade_type) + "s").join(" and ")} carry no max-loss figure — ` +
        "for covered calls the risk sits with the covering shares, and a naked call's is unbounded. " +
        "Return on premium fills the gap once trades close with their entry detail recorded.",
      basis: noRor.map((s) => `${label(s.trade_type)} ${s.n_pnl} closed, 0 measurable`).join(" · "),
      subjects: [],
    });
  }

  // Held-and-losing first, then unknowns, then the rest.
  const order: Record<InsightTone, number> = { negative: 0, unknown: 1, positive: 2, neutral: 3 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}
