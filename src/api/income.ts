import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

// ---- raw payload from the income-scanner edge function ---------------------
export interface PutContract {
  strike: number;
  delta: number; // absolute
  mid: number; // per share
  iv: number; // annualized decimal
  vol: number;
  oi: number;
}
export interface ExpirationChain {
  expiration: string; // ISO date
  dte: number;
  puts: PutContract[];
}
export interface IncomeName {
  ticker: string;
  sector: string;
  beta: number;
  spot: number;
  hv: number; // annualized decimal
  earnings: string | null; // next earnings date (ISO) or null
  expirations: ExpirationChain[];
}
export interface IncomePayload {
  generatedAt: string;
  count: number;
  names: IncomeName[];
  cached: boolean;
}

// ---- ranked candidate the table renders ------------------------------------
export type DivRating = "Poor" | "Good" | "Excellent";
export interface IncomeCandidate {
  ticker: string;
  sector: string;
  beta: number;
  spot: number;
  expiration: string;
  dte: number;
  strike: number;
  delta: number;
  iv: number;
  hv: number;
  ivHv: number; // vol-risk premium
  credit: number; // per share (mid)
  premium: number; // $ per contract
  collateral: number; // strike * 100
  annRoc: number; // annualized return on collateral (decimal)
  rating: DivRating;
  divWeight: number; // current portfolio weight of this sector
  score: number;
}

export interface ScanParams {
  maxPrice: number;
  targetDelta: number;
  targetDte: number;
  /** sector -> current risk weight of the active book (0-1). */
  sectorWeights: Record<string, number>;
}

const IV_HV_FLOOR = 0.8; // skip names where realized vol badly outruns implied (underpaid)
const MIN_LIQUIDITY = 50; // chosen contract must clear vol+oi floor
const TOP_N = 20;

function nearest<T>(items: T[], key: (t: T) => number, target: number): T | null {
  let best: T | null = null;
  let bd = Infinity;
  for (const it of items) {
    const d = Math.abs(key(it) - target);
    if (d < bd) {
      bd = d;
      best = it;
    }
  }
  return best;
}

function rate(weight: number): DivRating {
  if (weight < 0.05) return "Excellent";
  if (weight < 0.15) return "Good";
  return "Poor";
}

/**
 * Turn the cached chain payload into ranked CSP candidates for the given slider
 * settings. All selection happens client-side so the delta/DTE/price controls
 * are instant. Pipeline: pick expiration nearest target DTE -> put nearest
 * target delta -> drop on price/liquidity/IV-HV floor/earnings-in-window ->
 * score by (IV/HV) x annualized ROC x diversification -> top 20.
 */
export function rankCandidates(payload: IncomePayload | undefined, p: ScanParams): IncomeCandidate[] {
  if (!payload?.names) return [];
  const out: IncomeCandidate[] = [];

  for (const n of payload.names) {
    if (n.spot <= 0 || n.spot > p.maxPrice) continue;

    const exp = nearest(n.expirations, (e) => e.dte, p.targetDte);
    if (!exp || !exp.puts.length) continue;

    // Earnings before expiration => binary gap risk; exclude outright.
    if (n.earnings && n.earnings <= exp.expiration) continue;

    const put = nearest(exp.puts, (c) => c.delta, p.targetDelta);
    if (!put || put.mid <= 0 || put.strike <= 0) continue;
    if (put.vol + put.oi < MIN_LIQUIDITY) continue;

    const ivHv = n.hv > 0 ? put.iv / n.hv : 0;
    if (ivHv < IV_HV_FLOOR) continue;

    const collateral = put.strike * 100;
    const annRoc = (put.mid / put.strike) * (365 / Math.max(exp.dte, 1));
    const divWeight = p.sectorWeights[n.sector] ?? 0;
    const divFactor = Math.max(0, 1 - divWeight);
    const score = ivHv * annRoc * divFactor;

    out.push({
      ticker: n.ticker,
      sector: n.sector,
      beta: n.beta,
      spot: n.spot,
      expiration: exp.expiration,
      dte: exp.dte,
      strike: put.strike,
      delta: put.delta,
      iv: put.iv,
      hv: n.hv,
      ivHv,
      credit: put.mid,
      premium: put.mid * 100,
      collateral,
      annRoc,
      rating: rate(divWeight),
      divWeight,
      score,
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, TOP_N);
}

const KEY = "income-scan";

async function scan(force: boolean): Promise<IncomePayload> {
  const { data, error } = await supabase.functions.invoke("income-scanner", { body: { force } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as IncomePayload;
}

/** Cached scan (served from income_scan_cache unless older than the 15-min TTL). */
export function useIncomeScan() {
  return useQuery({
    queryKey: [KEY],
    queryFn: () => scan(false),
    staleTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** Force a live re-scan (the Refresh button). */
export function useIncomeRescan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => scan(true),
    onSuccess: (data) => qc.setQueryData([KEY], data),
  });
}
