import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

// ---- raw payload from the iv-surface edge function --------------------------
export interface BucketRow {
  b: string; // "P35" = put nearest |0.35| delta, "C25" = call nearest 0.25
  strike: number;
  delta: number; // signed
  iv: number; // decimal
  mid: number; // per share
  vega: number;
  theta: number;
  oi: number;
}
export interface SurfaceExpiration {
  expiration: string; // ISO date
  dte: number;
  atmIv: number;
  buckets: BucketRow[];
}
export interface IvSurfacePayload {
  ticker: string;
  spot: number;
  asOf: string;
  expirations: SurfaceExpiration[];
  cached: boolean;
}

/** Put wing (far OTM -> ATM) then call wing (ATM -> far OTM): the heatmap /
 *  differential x-axis walks the smile left to right. */
export const BUCKET_ORDER = [
  "P15", "P20", "P25", "P30", "P35", "P40", "P45", "P50",
  "C50", "C45", "C40", "C35", "C30", "C25", "C20", "C15",
];

export function bucketLabel(b: string): string {
  return `${b.slice(1)}Δ${b[0]}`; // "P35" -> "35ΔP"
}

// ---- double-diagonal pair evaluation -----------------------------------------
// The trade: sell a front-expiry strangle at the target delta, buy the same
// delta in a later expiry. Its engine is the front-minus-back IV differential,
// so every viable expiry pair is scored on exactly that.

export interface DiagonalLeg {
  expiration: string;
  dte: number;
  side: "P" | "C";
  action: "SELL" | "BUY";
  strike: number;
  delta: number;
  iv: number;
  mid: number;
}
export interface PairEval {
  front: string;
  frontDte: number;
  back: string;
  backDte: number;
  gap: number; // calendar days between expirations
  /** front IV minus back IV at the target delta, in vol points (e.g. 1.4). */
  putDiffPts: number;
  callDiffPts: number;
  combinedPts: number;
  atmDiffPts: number;
  legs: DiagonalLeg[];
  /** estimated net debit per share at mid. */
  debit: number;
  netVega: number;
  netTheta: number;
}

export type EdgeGrade = "Actionable" | "Marginal" | "No edge";
export function gradeEdge(combinedPts: number): EdgeGrade {
  if (combinedPts >= 1.5) return "Actionable";
  if (combinedPts >= 0.75) return "Marginal";
  return "No edge";
}

const MIN_FRONT_DTE = 3; // shorter fronts are pure gamma, not a diagonal
const GAP_MIN = 4; // need real decay separation between the expiries
const GAP_MAX = 21;

function bucket(exp: SurfaceExpiration, b: string): BucketRow | null {
  return exp.buckets.find((r) => r.b === b) ?? null;
}

/**
 * Score every front/back expiry pair at the target short delta. Returns pairs
 * sorted by combined front-minus-back IV differential (the edge), best first.
 * Pairs missing a quotable leg on either side are dropped rather than scored
 * on half a structure.
 */
export function evalPairs(payload: IvSurfacePayload | undefined, targetDelta: number): PairEval[] {
  if (!payload?.expirations?.length) return [];
  const bKey = Math.round(targetDelta * 100);
  const exps = payload.expirations;
  const out: PairEval[] = [];

  for (let i = 0; i < exps.length; i++) {
    const front = exps[i];
    if (front.dte < MIN_FRONT_DTE) continue;
    for (let j = i + 1; j < exps.length; j++) {
      const back = exps[j];
      const gap = back.dte - front.dte;
      if (gap < GAP_MIN) continue;
      if (gap > GAP_MAX) break; // exps sorted by dte; later backs only widen

      const fp = bucket(front, `P${bKey}`);
      const fc = bucket(front, `C${bKey}`);
      const bp = bucket(back, `P${bKey}`);
      const bc = bucket(back, `C${bKey}`);
      if (!fp || !fc || !bp || !bc) continue;

      const putDiffPts = (fp.iv - bp.iv) * 100;
      const callDiffPts = (fc.iv - bc.iv) * 100;
      const leg = (r: BucketRow, e: SurfaceExpiration, side: "P" | "C", action: "SELL" | "BUY"): DiagonalLeg => ({
        expiration: e.expiration,
        dte: e.dte,
        side,
        action,
        strike: r.strike,
        delta: r.delta,
        iv: r.iv,
        mid: r.mid,
      });

      out.push({
        front: front.expiration,
        frontDte: front.dte,
        back: back.expiration,
        backDte: back.dte,
        gap,
        putDiffPts: +putDiffPts.toFixed(2),
        callDiffPts: +callDiffPts.toFixed(2),
        combinedPts: +((putDiffPts + callDiffPts) / 2).toFixed(2),
        atmDiffPts: +((front.atmIv - back.atmIv) * 100).toFixed(2),
        legs: [
          leg(fp, front, "P", "SELL"),
          leg(fc, front, "C", "SELL"),
          leg(bp, back, "P", "BUY"),
          leg(bc, back, "C", "BUY"),
        ],
        debit: +(bp.mid + bc.mid - fp.mid - fc.mid).toFixed(2),
        netVega: +(bp.vega + bc.vega - fp.vega - fc.vega).toFixed(3),
        netTheta: +(bp.theta + bc.theta - fp.theta - fc.theta).toFixed(3),
      });
    }
  }

  return out.sort((a, b) => b.combinedPts - a.combinedPts);
}

// ---- query hooks ---------------------------------------------------------------
const KEY = "iv-surface";

async function fetchSurface(force: boolean): Promise<IvSurfacePayload> {
  const { data, error } = await supabase.functions.invoke("iv-surface", {
    body: { ticker: "SPY", force },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as IvSurfacePayload;
}

/** Cached surface (edge function serves iv_surface_cache within its 15-min TTL). */
export function useIvSurface() {
  return useQuery({
    queryKey: [KEY],
    queryFn: () => fetchSurface(false),
    staleTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** Force a live re-pull (the Refresh button). */
export function useIvSurfaceRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetchSurface(true),
    onSuccess: (data) => qc.setQueryData([KEY], data),
  });
}
