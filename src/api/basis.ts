import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { fetchCloses } from "./marketData";

// ---- vol-surface edge function payload --------------------------------------
export interface ExpSummary {
  expiration: string; // ISO date
  dte: number;
  atmIv: number; // decimal
  put25Iv: number | null;
  call25Iv: number | null;
  expectedMovePct: number; // fraction of spot, to expiration
}
export interface ContractQuote {
  expiration: string;
  strike: number;
  cp: "C" | "P";
  mid: number;
  delta: number;
  iv: number;
  /** Null unless `source` is "public" — the DoltHub fallback has only EOD
   *  greeks, which must not be read as live ones. */
  theta: number | null;
  vega: number | null;
}
export interface CcCandidate {
  expiration: string;
  dte: number;
  strike: number;
  delta: number;
  mid: number;
  annYield: number; // decimal, annualized premium / spot
}
export interface VolSurface {
  ticker: string;
  spot: number;
  source: "public" | "dolthub";
  asOf: string;
  earnings: string | null;
  expirations: ExpSummary[];
  contracts: ContractQuote[];
  ccCandidate: CcCandidate | null;
  cached: boolean;
}

export interface ContractRef {
  expiration: string;
  strike: number;
  /** Omit for a call — the edge function defaults to "C". */
  cp?: "C" | "P";
}

async function fetchVolSurface(
  ticker: string,
  contracts: ContractRef[],
): Promise<VolSurface> {
  const { data, error } = await supabase.functions.invoke("vol-surface", {
    body: { ticker, contracts },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as VolSurface;
}

/**
 * IV term structure (+ live LEAPS marks + CC candidate) for one ticker.
 * Cards for the same ticker share the query; the edge function additionally
 * caches per ticker for 15 min server-side.
 */
export function useVolSurface(ticker: string, contracts: ContractRef[] = []) {
  const key = contracts
    .map((c) => `${c.expiration}:${c.strike}:${c.cp ?? "C"}`)
    .sort()
    .join(",");
  return useQuery({
    queryKey: ["vol-surface", ticker, key],
    queryFn: () => fetchVolSurface(ticker, contracts),
    // The function rejects an empty ticker; callers that gate on a selection
    // pass "" rather than conditionally calling the hook.
    enabled: ticker.length > 0,
    staleTime: 15 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/** ~1y of daily closes, shared across cards for grade computation. */
export function useDailyCloses(ticker: string) {
  return useQuery({
    queryKey: ["closes-1y", ticker],
    queryFn: () => fetchCloses(ticker, 365),
    staleTime: 60 * 60_000,
    refetchOnWindowFocus: false,
  });
}
