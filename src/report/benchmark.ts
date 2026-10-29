/**
 * The market benchmark for the report: SPY, total return, aligned to the
 * book's own snapshot times.
 *
 * Total return, not price: the book's TWR includes whatever its positions paid
 * out, so comparing it against SPY's price alone would hand the book SPY's
 * ~1.2% yield for free. Yahoo's adjusted close folds dividends back in.
 *
 * Alignment is to the close each snapshot could actually have seen. A snapshot
 * taken at 00:55 UTC compares against the previous session's close, and one
 * taken mid-session against the prior day's — never against a close that had
 * not happened yet when the book was marked.
 */

export const BENCHMARK = "SPY";

/** A daily bar, keyed by when its close printed. */
export interface PriceBar {
  /** Epoch ms of the session close. */
  closeTs: number;
  /** Dividend-adjusted close. */
  close: number;
}

/**
 * Yahoo stamps a daily bar at the session open; the close is 6.5 hours later.
 * Half-days close earlier, which only makes this conservative: the bar is
 * treated as unseen for a few hours longer than it needs to be.
 */
const SESSION_MS = 6.5 * 3_600_000;

/**
 * Parse Yahoo's v8 chart response. The response is untrusted input from the
 * network: anything not shaped as expected yields no bars rather than a throw
 * deep in the report, and only finite positive prices are kept.
 */
export function parseYahooChart(json: unknown): PriceBar[] {
  const r = (json as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | {
        timestamp?: unknown;
        indicators?: { adjclose?: { adjclose?: unknown }[] };
      }
    | undefined;
  const ts = r?.timestamp;
  const adj = r?.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(ts) || !Array.isArray(adj) || ts.length !== adj.length) return [];
  const out: PriceBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const c = adj[i];
    if (typeof t !== "number" || typeof c !== "number") continue;
    if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) continue;
    out.push({ closeTs: t * 1000 + SESSION_MS, close: c });
  }
  return out.sort((a, b) => a.closeTs - b.closeTs);
}

/** The latest close printed at or before `ts`, or null if none had yet. */
export function closeAt(bars: PriceBar[], ts: number): number | null {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].closeTs <= ts) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? null : bars[found].close;
}

/** Benchmark return between two snapshot times, or null if either end is unpriced. */
export function benchmarkReturn(bars: PriceBar[], fromTs: number, toTs: number): number | null {
  const a = closeAt(bars, fromTs);
  const b = closeAt(bars, toTs);
  return a == null || b == null ? null : b / a - 1;
}
