import { supabase } from "@/lib/supabase";
import type { MarketQuote } from "@/types";

/** Invoke the market-data edge function. */
async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("market-data", { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as T;
}

/** Full quote: price, sector, beta, historical vol. */
export function fetchQuote(ticker: string): Promise<MarketQuote> {
  return invoke<MarketQuote>({ action: "quote", ticker });
}

/** Daily closes for a single ticker. */
export async function fetchCloses(ticker: string, days = 180): Promise<number[]> {
  const res = await invoke<{ closes: number[] }>({ action: "candles", ticker, days });
  return res.closes ?? [];
}

/** Daily closes for many tickers (for correlation matrices). */
export async function fetchBatchCloses(
  tickers: string[],
  days = 180,
): Promise<Record<string, number[]>> {
  if (tickers.length === 0) return {};
  const res = await invoke<{ closes: Record<string, number[]> }>({
    action: "batch_candles",
    tickers,
    days,
  });
  return res.closes ?? {};
}

// ---------------------------------------------------------------------------
// Client-side stats derived from closes (replaces pandas/yfinance correlation)
// ---------------------------------------------------------------------------

/** Daily simple returns from a close series. */
export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    out.push(closes[i] / closes[i - 1] - 1);
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const aa = a.slice(a.length - n);
  const bb = b.slice(b.length - n);
  const ma = aa.reduce((s, x) => s + x, 0) / n;
  const mb = bb.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = aa[i] - ma;
    const y = bb[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

export interface CorrelationResult {
  tickers: string[];
  matrix: number[][];
}

/** Correlation matrix of daily returns across tickers. */
export function correlationMatrix(
  closesByTicker: Record<string, number[]>,
): CorrelationResult {
  const tickers = Object.keys(closesByTicker).filter(
    (t) => (closesByTicker[t]?.length ?? 0) > 5,
  );
  const returns: Record<string, number[]> = {};
  for (const t of tickers) returns[t] = dailyReturns(closesByTicker[t]);

  const matrix = tickers.map((t1) =>
    tickers.map((t2) => (t1 === t2 ? 1 : pearson(returns[t1], returns[t2]))),
  );
  return { tickers, matrix };
}
