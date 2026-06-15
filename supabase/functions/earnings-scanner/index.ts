// Supabase Edge Function: earnings-scanner
// Ranks upcoming earnings as short iron-butterfly candidates.
//   1. Finnhub earnings calendar -> upcoming events (date + AMC/BMO).
//   2. Restrict to the researched universe (earnings_reliability table).
//   3. Live Yahoo option chain (front expiry AFTER the print) -> implied move,
//      ATM short straddle body + ~delta10 long wings = iron butterfly, with
//      credit / max-loss / max-gain / breakevens.
//   4. Join historical reliability (fly win-rate, premium richness, sample size).
//   5. Confidence score from the research flags; rank best-first.
// Results are cached (earnings_scan_cache) so the page loads instantly; the UI
// "Refresh" button calls with force=true to re-scan live.
//
// Deploy:  supabase functions deploy earnings-scanner
// Secret:  FINNHUB_API_KEY (already set for market-data)

import { createClient } from "jsr:@supabase/supabase-js@2";

const FINNHUB_KEY = Deno.env.get("FINNHUB_API_KEY") ?? "";
const FINNHUB = "https://finnhub.io/api/v1";
const YOPT = "https://query1.finance.yahoo.com/v7/finance/options";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RISK_FREE = 0.04;
const CACHE_TTL_MS = 20 * 60 * 1000;       // 20 min
const MAX_CANDIDATES = 28;                  // cap live Yahoo calls per scan
const WING_DELTA = 0.10;                     // long-wing target |delta| (defined risk)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---- math ----------------------------------------------------------------
function normCdf(x: number): number {
  // Abramowitz-Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function callDelta(S: number, K: number, T: number, sigma: number): number {
  if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) return S > K ? 1 : 0;
  const d1 = (Math.log(S / K) + (RISK_FREE + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return normCdf(d1);
}
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

type Contract = { strike: number; bid: number; ask: number; last: number; iv: number; vol: number; oi: number };
function mid(c: Contract): number {
  if (c.bid > 0 && c.ask > 0) return (c.bid + c.ask) / 2;
  return c.last > 0 ? c.last : (c.ask > 0 ? c.ask / 2 : 0);
}
function nearestStrike(list: Contract[], target: number): Contract | null {
  let best: Contract | null = null, bd = Infinity;
  for (const c of list) { const d = Math.abs(c.strike - target); if (d < bd) { bd = d; best = c; } }
  return best;
}

// ---- data fetchers -------------------------------------------------------
async function earningsCalendar(fromISO: string, toISO: string) {
  const r = await fetch(`${FINNHUB}/calendar/earnings?from=${fromISO}&to=${toISO}&token=${FINNHUB_KEY}`);
  const d = await r.json();
  return (d?.earningsCalendar ?? []) as Array<{ symbol: string; date: string; hour: string; epsEstimate: number | null }>;
}

function parseChain(node: any): { calls: Contract[]; puts: Contract[] } {
  const map = (arr: any[]): Contract[] =>
    (arr ?? []).map((o) => ({
      strike: +o.strike, bid: +(o.bid ?? 0), ask: +(o.ask ?? 0), last: +(o.lastPrice ?? 0),
      iv: +(o.impliedVolatility ?? 0), vol: +(o.volume ?? 0), oi: +(o.openInterest ?? 0),
    }));
  return { calls: map(node?.calls), puts: map(node?.puts) };
}

async function yahooOptions(sym: string, dateUnix?: number) {
  const url = dateUnix ? `${YOPT}/${sym}?date=${dateUnix}` : `${YOPT}/${sym}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const d = await r.json();
  const res = d?.optionChain?.result?.[0];
  if (!res) return null;
  return {
    spot: +(res.quote?.regularMarketPrice ?? 0),
    expirations: (res.expirationDates ?? []) as number[],
    first: res.options?.[0] ?? null, // { expirationDate, calls, puts }
  };
}

// ---- per-candidate butterfly ---------------------------------------------
async function buildCandidate(sym: string, earnDateISO: string, hour: string, rel: any) {
  const base = await yahooOptions(sym);
  if (!base || base.spot <= 0 || base.expirations.length === 0) return null;
  const earnUnix = Math.floor(new Date(earnDateISO + "T00:00:00Z").getTime() / 1000);
  // first expiration on/after the earnings date (captures the event)
  const targetExp = base.expirations.find((e) => e >= earnUnix - 86400) ?? base.expirations[0];

  let chainNode = base.first;
  if (!chainNode || chainNode.expirationDate !== targetExp) {
    const r2 = await yahooOptions(sym, targetExp);
    chainNode = r2?.first ?? chainNode;
  }
  if (!chainNode) return null;
  const { calls, puts } = parseChain(chainNode);
  if (!calls.length || !puts.length) return null;

  const spot = base.spot;
  const expUnix = chainNode.expirationDate ?? targetExp;
  const dteDays = Math.max(1, Math.round((expUnix * 1000 - Date.now()) / 86400000));
  const T = dteDays / 365;

  // ATM straddle body
  const atmC = nearestStrike(calls, spot)!, atmP = nearestStrike(puts, spot)!;
  const atmK = Math.abs(atmC.strike - spot) <= Math.abs(atmP.strike - spot) ? atmC.strike : atmP.strike;
  const bodyC = calls.find((c) => c.strike === atmK) ?? atmC;
  const bodyP = puts.find((p) => p.strike === atmK) ?? atmP;
  const straddle = mid(bodyC) + mid(bodyP);
  if (straddle <= 0) return null;
  const impliedMove = straddle / spot;

  // long wings at ~WING_DELTA (defined risk near the expected-move edge)
  let wingC: Contract | null = null, wcd = Infinity;
  for (const c of calls) {
    if (c.strike <= atmK) continue;
    const dd = Math.abs(callDelta(spot, c.strike, T, c.iv) - WING_DELTA);
    if (dd < wcd) { wcd = dd; wingC = c; }
  }
  let wingP: Contract | null = null, wpd = Infinity;
  for (const p of puts) {
    if (p.strike >= atmK) continue;
    const putDelta = callDelta(spot, p.strike, T, p.iv) - 1; // delta of put
    const dd = Math.abs(Math.abs(putDelta) - WING_DELTA);
    if (dd < wpd) { wpd = dd; wingP = p; }
  }
  if (!wingC || !wingP) return null;

  const credit = straddle - (mid(wingC) + mid(wingP));
  const callW = wingC.strike - atmK, putW = atmK - wingP.strike;
  const width = Math.max(callW, putW);
  if (credit <= 0 || width <= 0) return null;
  const maxLoss = Math.max(0.01, width - credit);
  const maxGain = credit;

  const atmIv = (bodyC.iv + bodyP.iv) / 2;
  const liq = (bodyC.vol + bodyP.vol) + 0.2 * (bodyC.oi + bodyP.oi);
  const richness = rel?.avg_actual > 0 ? impliedMove / rel.avg_actual : null;

  // ---- confidence score (0-100) from research flags ----
  const richC = richness != null ? clamp((richness - 0.9) / 0.6) : 0.4;          // 0.9->0 .. 1.5->1
  const histC = rel?.fly_win != null ? clamp((rel.fly_win - 0.4) / 0.4) : 0.3;   // 40%->0 .. 80%->1
  const ivC = clamp((atmIv - 0.3) / 0.5);                                         // 30%->0 .. 80%->1
  const nC = rel?.n != null ? clamp(rel.n / 12) : 0;
  const amcC = hour === "amc" ? 1 : hour === "bmo" ? 0.7 : 0.5;
  const liqGate = liq >= 500 ? 1 : liq >= 100 ? 0.8 : 0.6;
  const confidence = Math.round(
    100 * liqGate * (0.34 * richC + 0.30 * histC + 0.16 * ivC + 0.10 * nC + 0.10 * amcC),
  );

  return {
    ticker: sym,
    earningsDate: earnDateISO,
    when: hour === "amc" ? "AMC" : hour === "bmo" ? "BMO" : hour === "dmh" ? "DMH" : "—",
    spot: +spot.toFixed(2),
    expiration: new Date(expUnix * 1000).toISOString().slice(0, 10),
    dte: dteDays,
    impliedMovePct: +(impliedMove * 100).toFixed(2),
    histMovePct: rel?.avg_actual != null ? +(rel.avg_actual * 100).toFixed(2) : null,
    premiumRichness: richness != null ? +richness.toFixed(2) : null,
    atmIvPct: +(atmIv * 100).toFixed(1),
    flyWinPct: rel?.fly_win != null ? Math.round(rel.fly_win * 100) : null,
    sampleN: rel?.n ?? 0,
    butterfly: {
      shortStrike: atmK,
      longCall: wingC.strike,
      longPut: wingP.strike,
      credit: +credit.toFixed(2),
      maxGain: +(maxGain * 100).toFixed(0),   // per 1 contract (x100)
      maxLoss: +(maxLoss * 100).toFixed(0),
      beLow: +(atmK - credit).toFixed(2),
      beHigh: +(atmK + credit).toFixed(2),
      callWidth: +callW.toFixed(2),
      putWidth: +putW.toFixed(2),
    },
    liquidity: Math.round(liq),
    confidence,
  };
}

// simple concurrency pool
async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...await Promise.all(batch.map(fn)));
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const days = Math.min(14, Math.max(1, +body.days || 7));
    const force = !!body.force;
    const cacheKey = `${days}d`;
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // serve fresh cache unless forced
    if (!force) {
      const { data: cached } = await sb.from("earnings_scan_cache").select("payload, created_at").eq("id", cacheKey).maybeSingle();
      if (cached && Date.now() - new Date(cached.created_at).getTime() < CACHE_TTL_MS) {
        return json({ ...cached.payload, cached: true });
      }
    }

    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const to = new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);

    const [cal, relRows] = await Promise.all([
      earningsCalendar(from, to),
      sb.from("earnings_reliability").select("*"),
    ]);
    const relMap = new Map<string, any>((relRows.data ?? []).map((r: any) => [r.ticker, r]));

    // de-dupe by symbol, keep only researched universe, cap candidate count
    const seen = new Set<string>();
    const candidates = cal
      .filter((e) => e.symbol && relMap.has(e.symbol) && !seen.has(e.symbol) && (seen.add(e.symbol), true))
      .slice(0, MAX_CANDIDATES);

    const built = await pool(candidates, 5, async (e) => {
      try { return await buildCandidate(e.symbol, e.date, e.hour, relMap.get(e.symbol)); }
      catch { return null; }
    });
    const results = built.filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => b.confidence - a.confidence);

    const payload = { generatedAt: new Date().toISOString(), window: cacheKey, count: results.length, results, cached: false };
    await sb.from("earnings_scan_cache").upsert({ id: cacheKey, payload, created_at: new Date().toISOString() });
    return json(payload);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
