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
import type { MarketQuote, Portfolio, Trade } from "@/types";

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

  const updated: string[] = [];
  const next: Trade[] = [];
  for (const t of trades) {
    const q = quotes.get(t.ticker);
    if (!q) {
      next.push(t);
      continue;
    }
    const merged: Trade = {
      ...t,
      underlying_price: Number(q.price.toFixed(2)),
      iv: t.trade_type === "shares" ? q.hv : t.iv,
      sector: q.sector || t.sector,
      beta: q.beta || t.beta,
    };
    next.push(merged);
    const { error } = await client
      .from("trades")
      .update({
        underlying_price: merged.underlying_price,
        iv: merged.iv,
        sector: merged.sector,
        beta: merged.beta,
      })
      .eq("id", t.id);
    if (error) throw error;
    updated.push(t.ticker);
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
  };
}

/**
 * One snapshot per portfolio per day, timestamped to a fixed hour so repeated
 * runs land in the same bucket regardless of when they fire. Returns false when
 * the day already has one.
 */
export async function recordSnapshot(
  client: SupabaseClient,
  userId: string,
  portfolioId: string,
  metrics: SnapshotMetrics,
  now = new Date(),
): Promise<boolean> {
  const stamped = new Date(now);
  stamped.setUTCHours(16, 0, 0, 0);
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
