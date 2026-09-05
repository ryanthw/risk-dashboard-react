import { useMemo } from "react";
import { useVolSurface, type ContractRef, type VolSurface } from "./basis";
import { optionLegsOf, quoteKey, type LiveQuote } from "@/engine/positionAnalysis";
import type { Trade } from "@/types";

/**
 * Live quotes for the contracts a ticker's book holds, adapted from the
 * vol-surface edge function.
 *
 * vol-surface is already the app's per-ticker options service: it discovers
 * expirations, pulls live greeks from Public, and quotes specific contracts on
 * request (the Basis Tracker uses that for LEAPS marks). Position Analysis
 * needs the same call with puts and theta/vega, so it asks the same service
 * rather than standing up a second one that would duplicate the Public auth,
 * chain fetch and strike matching — and could drift from it.
 */
export function usePositionGreeks(trades: Trade[], enabled = true) {
  const ticker = trades[0]?.ticker?.toUpperCase() ?? "";

  // Every distinct contract in the book, deduped — a strike held by two
  // positions is one quote.
  const refs = useMemo<ContractRef[]>(() => {
    const seen = new Map<string, ContractRef>();
    for (const t of trades) {
      if (!t.expiration) continue;
      for (const l of optionLegsOf(t)) {
        const cp = l.cp === "call" ? ("C" as const) : ("P" as const);
        const k = `${t.expiration}:${l.strike}:${cp}`;
        if (!seen.has(k)) seen.set(k, { expiration: t.expiration, strike: l.strike, cp });
      }
    }
    return [...seen.values()];
  }, [trades]);

  const query = useVolSurface(enabled && ticker && refs.length ? ticker : "", refs);

  /**
   * Quotes are taken only when Public served the payload. On the DoltHub
   * fallback the greeks are end-of-day and theta/vega are absent entirely, so
   * the whole book drops to Black-Scholes and tags BS rather than mixing a
   * stale delta into a live P&L readout.
   */
  const quotes = useMemo<Record<string, LiveQuote> | null>(() => {
    const data = query.data as VolSurface | undefined;
    if (!data || data.source !== "public" || !data.contracts?.length) return null;

    const out: Record<string, LiveQuote> = {};
    for (const c of data.contracts) {
      if (!(c.iv > 0) || c.theta == null || c.vega == null) continue;
      out[quoteKey(data.ticker, c.expiration, c.strike, c.cp === "P" ? "put" : "call")] = {
        iv: c.iv,
        delta: c.delta,
        theta: c.theta,
        vega: c.vega,
        mid: c.mid,
      };
    }
    return Object.keys(out).length ? out : null;
  }, [query.data]);

  return { quotes, isFetching: query.isFetching, asOf: query.data?.asOf ?? null };
}
