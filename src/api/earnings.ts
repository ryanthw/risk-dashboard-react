import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface ButterflyLeg {
  shortStrike: number;
  longCall: number;
  longPut: number;
  credit: number;
  maxGain: number; // per 1 contract (x100)
  maxLoss: number;
  beLow: number;
  beHigh: number;
  callWidth: number;
  putWidth: number;
}

export interface ScanCandidate {
  ticker: string;
  earningsDate: string;
  when: "AMC" | "BMO" | "DMH" | "—";
  spot: number;
  expiration: string;
  dte: number;
  impliedMovePct: number;
  histMovePct: number | null;
  premiumRichness: number | null;
  atmIvPct: number;
  flyWinPct: number | null;
  sampleN: number;
  butterfly: ButterflyLeg;
  liquidity: number;
  confidence: number;
}

export interface ScanResult {
  generatedAt: string;
  window: string;
  count: number;
  results: ScanCandidate[];
  cached: boolean;
}

const KEY = "earnings-scan";

async function scan(days: number, force: boolean): Promise<ScanResult> {
  const { data, error } = await supabase.functions.invoke("earnings-scanner", {
    body: { days, force },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as ScanResult;
}

/** Cached scan (served from earnings_scan_cache unless stale). */
export function useEarningsScan(days = 7) {
  return useQuery({
    queryKey: [KEY, days],
    queryFn: () => scan(days, false),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** Force a live re-scan (the Refresh button). */
export function useRescan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => scan(days, true),
    onSuccess: (data, days) => qc.setQueryData([KEY, days], data),
  });
}
