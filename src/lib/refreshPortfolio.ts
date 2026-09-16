/**
 * Portfolio refresh, independent of React.
 *
 * The browser hook and the scheduled snapshot job run the identical sequence:
 * pull quotes, persist underlyings, then log one snapshot for the day. It lives
 * here rather than in useRefreshMarketData so the Node job can't drift from
 * what the app does — and it takes a client rather than importing the browser
 * singleton, which reads Vite env vars that don't exist outside the bundle.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveTradeMetrics } from "@/engine/trade";
import { snapshotMetrics, type Position, type SnapshotMetrics } from "@/engine/portfolio";
import type { IvSource, MarketQuote, Portfolio, Trade, TradeType } from "@/types";

/**
 * A quote further than this from the stored price is treated as bad data
 * rather than a real move. Wide enough that ordinary small-cap volatility
 * passes; tight enough to catch a decimal slip or a wrong-symbol response.
 */
export const MAX_QUOTE_MOVE_PCT = 35;

export interface RejectedQuote {
  ticker: string;
  stored: number;
  quoted: number;
  movePct: number;
}

export interface RefreshReport {
  updated: string[];
  /** Quotes refused by the sanity guard; their trades keep the stored price. */
  rejected: RejectedQuote[];
  /** Tickers whose quote call failed outright. */
  failed: string[];
  snapshotLogged: boolean;
  /** Set when the snapshot was deliberately skipped rather than merely deduped. */
  skippedReason: "already-logged-today" | "degraded-quotes" | null;
  metrics: SnapshotMetrics | null;
  /** How the option book's implied vol resolved this run. */
  iv: IvReport;
}

export interface IvReport {
  /** Positions marked from a trusted contract quote. */
  contract: number;
  /** Positions rebuilt from ATM IV and their stored skew ratio. */
  atmSkew: number;
  /** Positions left at their previous mark, with the reason each was held. */
  held: { ticker: string; reason: string }[];
  /** `TICKER|expiration` groups whose chain could not be read at all. */
  failedGroups: string[];
}

/**
 * Which side of the chain a structure's primary leg sits on. For spreads this
 * is the leg at `strike` — the short leg on a credit spread — which is where
 * the position's vega and its assignment risk actually live.
 */
const PUT_TYPES = new Set<TradeType>(["csp", "short_put", "long_put", "pcs", "pds"]);
const CALL_TYPES = new Set<TradeType>(["cc", "short_call", "long_call", "ccs", "cds"]);

function rightOf(t: TradeType): "C" | "P" | null {
  if (PUT_TYPES.has(t)) return "P";
  if (CALL_TYPES.has(t)) return "C";
  return null; // shares — no implied vol to mark
}

/** True when the trade was opened on the same UTC day as `now`. */
function openedOn(t: Trade, now: Date): boolean {
  if (!t.opened_at) return false;
  return new Date(t.opened_at).toISOString().slice(0, 10) ===
    now.toISOString().slice(0, 10);
}

interface ResolvedIv {
  id: string;
  iv: number;
  source: IvSource;
  atm_iv: number | null;
  skew_ratio: number | null;
  reason: string | null;
}

/**
 * Resolve a current IV per option position. Best-effort by design: the chain is
 * a second network dependency on top of quotes, and a refresh that fails
 * outright because one illiquid name's chain is down is worse than one that
 * marks what it can and says what it held.
 */
async function resolveIv(
  client: SupabaseClient,
  trades: Trade[],
): Promise<{ byId: Map<string, ResolvedIv>; failedGroups: string[] }> {
  const positions = trades.flatMap((t) => {
    const right = rightOf(t.trade_type);
    if (!right || !t.expiration || !t.strike) return [];
    return [{
      id: t.id,
      ticker: t.ticker,
      expiration: t.expiration,
      strike: t.strike,
      right,
      iv: t.iv,
      iv_skew_ratio: t.iv_skew_ratio,
    }];
  });
  if (!positions.length) return { byId: new Map(), failedGroups: [] };

  try {
    const { data, error } = await client.functions.invoke("position-iv", {
      body: { positions },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    const byId = new Map<string, ResolvedIv>();
    for (const r of (data?.results ?? []) as ResolvedIv[]) byId.set(r.id, r);
    return { byId, failedGroups: (data?.failedGroups ?? []) as string[] };
  } catch {
    // Every position keeps its previous mark; the report says the whole call
    // went down rather than implying each contract was individually unreadable.
    return { byId: new Map(), failedGroups: ["*"] };
  }
}

export interface RefreshOptions {
  maxMovePct?: number;
  /**
   * Refuse to log a snapshot when any quote was rejected or failed. The
   * unattended job sets this: a snapshot computed from stale or suspect prices
   * is worse than no snapshot, because nothing downstream can tell it apart
   * from a good one.
   */
  requireCleanQuotes?: boolean;
  now?: Date;
}

async function fetchQuote(
  client: SupabaseClient,
  ticker: string,
): Promise<MarketQuote> {
  const { data, error } = await client.functions.invoke("market-data", {
    body: { action: "quote", ticker },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as MarketQuote;
}

export async function refreshPortfolio(
  client: SupabaseClient,
  userId: string,
  portfolio: Portfolio,
  trades: Trade[],
  opts: RefreshOptions = {},
): Promise<RefreshReport> {
  const maxMovePct = opts.maxMovePct ?? MAX_QUOTE_MOVE_PCT;
  const now = opts.now ?? new Date();

  const tickers = [...new Set(trades.map((t) => t.ticker))];
  const quotes = new Map<string, MarketQuote>();
  const failed: string[] = [];
  const rejected: RejectedQuote[] = [];

  await Promise.all(
    tickers.map(async (tk) => {
      try {
        const q = await fetchQuote(client, tk);
        if (q && q.price > 0) quotes.set(tk, q);
        else failed.push(tk);
      } catch {
        failed.push(tk);
      }
    }),
  );

  // Guard before writing anything: compare each quote against the price we
  // already hold for that ticker.
  for (const [tk, q] of quotes) {
    const stored = trades.find((t) => t.ticker === tk)?.underlying_price ?? 0;
    if (stored <= 0) continue; // Nothing to compare against — first fill.
    const movePct = Math.abs(q.price / stored - 1) * 100;
    if (movePct > maxMovePct) {
      rejected.push({ ticker: tk, stored, quoted: q.price, movePct });
      quotes.delete(tk);
    }
  }

  const { byId: ivById, failedGroups } = await resolveIv(client, trades);

  const updated: string[] = [];
  const next: Trade[] = [];
  const ivReport: IvReport = { contract: 0, atmSkew: 0, held: [], failedGroups };

  for (const t of trades) {
    const q = quotes.get(t.ticker);
    const r = ivById.get(t.id);

    if (r) {
      if (r.source === "contract") ivReport.contract += 1;
      else if (r.source === "atm_skew") ivReport.atmSkew += 1;
      else ivReport.held.push({ ticker: t.ticker, reason: r.reason ?? "held" });
    }

    // Shares have no implied vol; their `iv` column carries realized vol from
    // the quote, as it always has. Options take the resolved mark.
    const nextIv =
      t.trade_type === "shares" ? (q ? q.hv : t.iv) : r ? r.iv : t.iv;

    const merged: Trade = {
      ...t,
      underlying_price: q ? Number(q.price.toFixed(2)) : t.underlying_price,
      iv: nextIv,
      sector: q ? q.sector || t.sector : t.sector,
      beta: q ? q.beta || t.beta : t.beta,
      iv_source: r ? r.source : t.iv_source,
      iv_skew_ratio: r?.skew_ratio ?? t.iv_skew_ratio,
    };
    next.push(merged);

    // Quotes and the IV mark fail independently — a name whose quote was
    // rejected can still have a readable chain, and vice versa — so the write
    // carries whichever half succeeded rather than being all-or-nothing.
    const patch: Record<string, unknown> = {};
    if (q) {
      patch.underlying_price = merged.underlying_price;
      patch.sector = merged.sector;
      patch.beta = merged.beta;
      if (t.trade_type === "shares") patch.iv = merged.iv;
    }
    if (r) {
      patch.iv = merged.iv;
      patch.iv_source = r.source;
      if (r.skew_ratio != null) patch.iv_skew_ratio = r.skew_ratio;
      // Stamped only on a real read, so the column means "when this mark last
      // came from the market" and a held position visibly stops advancing.
      if (r.source !== "last_good") patch.iv_updated_at = now.toISOString();
      // The surface this position was opened against — recorded only on the day
      // it was opened. An ATM reading taken three weeks later is a fine mark but
      // it is not an entry condition, and storing it as one would quietly
      // fabricate the baseline the attribution work is meant to measure against.
      if (t.atm_iv_at_open == null && r.atm_iv != null && openedOn(t, now)) {
        patch.atm_iv_at_open = r.atm_iv;
      }
    }
    if (Object.keys(patch).length === 0) continue;

    const { error } = await client.from("trades").update(patch).eq("id", t.id);
    if (error) throw error;
    if (q) updated.push(t.ticker);
  }

  const positions: Position[] = next.map((trade) => ({
    trade,
    metrics: deriveTradeMetrics(trade),
  }));
  const metrics = snapshotMetrics(positions, portfolio.cash);

  const degraded = rejected.length > 0 || failed.length > 0;
  if (opts.requireCleanQuotes && degraded) {
    return {
      updated,
      rejected,
      failed,
      snapshotLogged: false,
      skippedReason: "degraded-quotes",
      metrics,
      iv: ivReport,
    };
  }

  const logged = await recordSnapshot(client, userId, portfolio.id, metrics, now);
  return {
    updated,
    rejected,
    failed,
    snapshotLogged: logged,
    skippedReason: logged ? null : "already-logged-today",
    metrics,
    iv: ivReport,
  };
}

/**
 * One snapshot per portfolio per day. Returns false when the day already has one.
 *
 * Stamped at the moment it is taken, not normalized to a fixed hour. The
 * normalization used to backdate every snapshot to 16:00 UTC, which broke the
 * invariant TWR depends on: that a snapshot's value reflects exactly the flows
 * dated at or before its timestamp. Deposit at 18:00 and refresh at 18:05 and
 * the balance jumped with no flow to explain it, then the flow turned up in the
 * next period where the balance had not moved — a phantom gain followed by a
 * phantom loss, which does not cancel and wrecks the volatility estimate.
 *
 * Dedupe still buckets by UTC calendar day, matching the one-per-day index.
 */
export async function recordSnapshot(
  client: SupabaseClient,
  userId: string,
  portfolioId: string,
  metrics: SnapshotMetrics,
  now = new Date(),
): Promise<boolean> {
  const stamped = new Date(now);
  const dayStart = new Date(stamped);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(stamped);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const { data: existing } = await client
    .from("history_snapshots")
    .select("id")
    .eq("portfolio_id", portfolioId)
    .gte("ts", dayStart.toISOString())
    .lte("ts", dayEnd.toISOString());
  if (existing && existing.length > 0) return false;

  const { error } = await client.from("history_snapshots").insert({
    ...metrics,
    portfolio_id: portfolioId,
    user_id: userId,
    ts: stamped.toISOString(),
  });
  if (error) throw error;
  return true;
}
