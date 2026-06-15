// Supabase Edge Function: earnings-scanner
// Ranks upcoming earnings as short iron-butterfly candidates.
//   1. Finnhub earnings calendar -> upcoming events (date + AMC/BMO).
//   2. Restrict to the researched universe (earnings_reliability table).
//   3. Live CBOE delayed option chain (front expiry AFTER the print) -> implied
//      move, ATM short straddle body + ~delta10 long wings = iron butterfly,
//      with credit / max-loss / max-gain / breakevens. CBOE provides greeks
//      (delta) directly, so wing selection needs no Black-Scholes.
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
const CBOE = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CACHE_TTL_MS = 20 * 60 * 1000;       // 20 min
const MAX_CANDIDATES = 50;                  // cap live option-chain fetches per scan
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

// ---- helpers -------------------------------------------------------------
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const normIv = (x: number) => (x > 3 ? x / 100 : x); // CBOE iv may be % or decimal

// A single option contract parsed from the CBOE delayed-quote feed.
type Contract = {
  cp: "C" | "P"; strike: number; expUnix: number;
  bid: number; ask: number; last: number; iv: number; delta: number; vol: number; oi: number;
};
function mid(c: Contract): number {
  if (c.bid > 0 && c.ask > 0) return (c.bid + c.ask) / 2;
  return c.last > 0 ? c.last : (c.ask > 0 ? c.ask / 2 : 0);
}
function nearestStrike(list: Contract[], target: number): Contract | null {
  let best: Contract | null = null, bd = Infinity;
  for (const c of list) { const d = Math.abs(c.strike - target); if (d < bd) { bd = d; best = c; } }
  return best;
}

// Parse an OCC option symbol, e.g. "JBL260618C00070000" -> Call, 2026-06-18, strike 70.
// The trailing 15 chars are fixed (YYMMDD + C/P + 8-digit strike); the root precedes them.
function parseOcc(occ: string): { cp: "C" | "P"; strike: number; expUnix: number } | null {
  if (occ.length < 16) return null;
  const strikeRaw = occ.slice(-8), cp = occ.slice(-9, -8);
  const yy = occ.slice(-15, -13), mm = occ.slice(-13, -11), dd = occ.slice(-11, -9);
  if ((cp !== "C" && cp !== "P") || !/^\d{6}$/.test(yy + mm + dd) || !/^\d{8}$/.test(strikeRaw)) return null;
  return {
    cp,
    strike: +strikeRaw / 1000,
    expUnix: Math.floor(Date.UTC(2000 + +yy, +mm - 1, +dd) / 1000),
  };
}

// ---- data fetchers -------------------------------------------------------
async function earningsCalendar(fromISO: string, toISO: string) {
  const r = await fetch(`${FINNHUB}/calendar/earnings?from=${fromISO}&to=${toISO}&token=${FINNHUB_KEY}`);
  const d = await r.json();
  return (d?.earningsCalendar ?? []) as Array<{ symbol: string; date: string; hour: string; epsEstimate: number | null }>;
}

// Live CBOE delayed (~15 min) option chain: spot + parsed calls/puts with greeks.
async function cboeOptions(sym: string): Promise<{ spot: number; calls: Contract[]; puts: Contract[] } | null> {
  const r = await fetch(`${CBOE}/${encodeURIComponent(sym)}.json`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const d = await r.json();
  const data = d?.data;
  if (!data || !Array.isArray(data.options)) return null;
  const calls: Contract[] = [], puts: Contract[] = [];
  for (const o of data.options) {
    const p = parseOcc(String(o.option ?? ""));
    if (!p) continue;
    const c: Contract = {
      cp: p.cp, strike: p.strike, expUnix: p.expUnix,
      bid: +(o.bid ?? 0), ask: +(o.ask ?? 0), last: +(o.last_trade_price ?? 0),
      iv: normIv(+(o.iv ?? 0)), delta: +(o.delta ?? 0), vol: +(o.volume ?? 0), oi: +(o.open_interest ?? 0),
    };
    (p.cp === "C" ? calls : puts).push(c);
  }
  return { spot: +(data.current_price ?? 0), calls, puts };
}

// Recent realized daily vol (decimal) from Yahoo daily candles — the v8 chart
// endpoint works without a crumb (only the v7 options endpoint is gated).
const YCHART = "https://query1.finance.yahoo.com/v8/finance/chart";
async function recentDailyVol(sym: string): Promise<number> {
  try {
    const r = await fetch(`${YCHART}/${sym}?range=3mo&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return 0.02;
    const d = await r.json();
    const closes = (d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [])
      .filter((x: number | null): x is number => typeof x === "number");
    if (closes.length < 11) return 0.02;
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    const recent = rets.slice(-30);
    const m = recent.reduce((a, b) => a + b, 0) / recent.length;
    const v = recent.reduce((a, b) => a + (b - m) ** 2, 0) / recent.length;
    return Math.sqrt(v) || 0.02;
  } catch {
    return 0.02;
  }
}

// ---- per-candidate butterfly ---------------------------------------------
async function buildCandidate(sym: string, earnDateISO: string, hour: string, rel: any) {
  const chain = await cboeOptions(sym);
  if (!chain || chain.spot <= 0 || !chain.calls.length || !chain.puts.length) return null;
  const spot = chain.spot;
  const earnUnix = Math.floor(new Date(earnDateISO + "T00:00:00Z").getTime() / 1000);

  // first expiration on/after the earnings date (captures the event)
  const exps = [...new Set(chain.calls.map((c) => c.expUnix))].sort((a, b) => a - b);
  const targetExp = exps.find((e) => e >= earnUnix - 86400) ?? exps[exps.length - 1];
  if (!targetExp) return null;

  const tradable = (c: Contract) => c.expUnix === targetExp && (c.bid > 0 || c.ask > 0);
  const calls = chain.calls.filter(tradable);
  const puts = chain.puts.filter(tradable);
  if (!calls.length || !puts.length) return null;

  const expUnix = targetExp;
  const dteDays = Math.max(1, Math.round((expUnix * 1000 - Date.now()) / 86400000));

  // ATM straddle body: nearest-to-spot strike listed for BOTH a call and a put
  const callStrikes = new Set(calls.map((c) => c.strike));
  const common = puts.filter((p) => callStrikes.has(p.strike)).map((p) => p.strike);
  if (!common.length) return null;
  const atmK = common.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a));
  const bodyC = calls.find((c) => c.strike === atmK)!;
  const bodyP = puts.find((p) => p.strike === atmK)!;
  const straddle = mid(bodyC) + mid(bodyP);
  if (straddle <= 0) return null;
  const impliedMove = straddle / spot;

  // long wings at ~WING_DELTA using CBOE's reported delta (defined risk)
  let wingC: Contract | null = null, wcd = Infinity;
  for (const c of calls) {
    if (c.strike <= atmK || mid(c) <= 0) continue;
    const dd = Math.abs(c.delta - WING_DELTA);
    if (dd < wcd) { wcd = dd; wingC = c; }
  }
  let wingP: Contract | null = null, wpd = Infinity;
  for (const p of puts) {
    if (p.strike >= atmK || mid(p) <= 0) continue;
    const dd = Math.abs(Math.abs(p.delta) - WING_DELTA);
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

  // back-month ATM IV (>= ~2 weeks past the front expiry) for the IV term structure
  const backExp = exps.find((e) => e >= targetExp + 14 * 86400);
  let backIv: number | null = null;
  if (backExp) {
    const bc = nearestStrike(chain.calls.filter((c) => c.expUnix === backExp && c.iv > 0), spot);
    const bp = nearestStrike(chain.puts.filter((p) => p.expUnix === backExp && p.iv > 0), spot);
    if (bc && bp) backIv = (bc.iv + bp.iv) / 2;
  }

  // Richness. With history: DTE-robust = live implied move vs the move you'd EXPECT
  // to the same expiry (sqrt(earnings_jump^2 + diffusion over non-event days)) — makes
  // a 2-DTE front-week and a 31-DTE monthly comparable. Without history: fall back to
  // the live IV term-structure premium (front ATM IV / back-month ATM IV); >1 means the
  // event is bid up. Two different scales, but no-history names live in their own list.
  const hasHistory = rel != null && rel.n != null;
  let richness: number | null;
  if (hasHistory && rel.avg_actual > 0) {
    const baseVol = await recentDailyVol(sym);
    const expMove = Math.sqrt(rel.avg_actual ** 2 + baseVol * baseVol * Math.max(0, dteDays - 1));
    richness = expMove > 0 ? impliedMove / expMove : null;
  } else {
    richness = backIv && backIv > 0 ? atmIv / backIv : null;
  }

  // ---- confidence score (0-100) from research flags ----
  const richSpread = hasHistory ? 0.4 : 0.6;                                      // no-history ratios run wider
  const richC = richness != null ? clamp((richness - 1.0) / richSpread) : 0.35;
  const histC = rel?.fly_win != null ? clamp((rel.fly_win - 0.4) / 0.4) : 0.3;   // 40%->0 .. 80%->1
  const ivC = clamp((atmIv - 0.3) / 0.5);                                         // 30%->0 .. 80%->1
  const nC = rel?.n != null ? clamp(rel.n / 12) : 0;
  const amcC = hour === "amc" ? 1 : hour === "bmo" ? 0.7 : 0.5;
  // DTE suitability: this is a front-week IV-crush trade. A clean ~2-9 DTE expiry
  // is ideal; a far monthly (no weeklies) both inflates the implied-move signal and
  // isn't the same overnight trade, so it is penalised.
  const dteC = dteDays <= 9 ? 1 : dteDays <= 21 ? clamp(1 - (dteDays - 9) / 24) : 0.35;
  const liqGate = liq >= 500 ? 1 : liq >= 100 ? 0.8 : 0.6;
  const confidence = Math.round(
    100 * liqGate * (0.28 * richC + 0.26 * histC + 0.14 * ivC + 0.10 * nC + 0.08 * amcC + 0.14 * dteC),
  );

  return {
    ticker: sym,
    hasHistory,
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
    const debug = !!body.debug;
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

    // De-dupe by symbol. Include the WHOLE calendar (not just the researched
    // universe) so every upcoming earnings can surface, but prioritise: all names
    // with backtested history first, then analyst-covered names (a free proxy for
    // having liquid options), capped to bound live option-chain fetches.
    const seen = new Set<string>();
    const uniq = cal.filter((e) => e.symbol && !seen.has(e.symbol) && (seen.add(e.symbol), true));
    const withHist = uniq.filter((e) => relMap.has(e.symbol));
    const noHist = uniq
      .filter((e) => !relMap.has(e.symbol))
      .sort((a, b) => (a.epsEstimate != null ? 0 : 1) - (b.epsEstimate != null ? 0 : 1));
    const candidates = [...withHist, ...noHist].slice(0, MAX_CANDIDATES);

    const built = await pool(candidates, 5, async (e) => {
      try { return await buildCandidate(e.symbol, e.date, e.hour, relMap.get(e.symbol) ?? null); }
      catch { return null; }
    });
    const results = built.filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => b.confidence - a.confidence);

    if (debug) {
      const calSyms = cal.map((e) => e.symbol);
      const probe = ["JBL", "KMX", "KR"].map((t) => ({
        t,
        inCalendar: calSyms.includes(t),
        inReliability: relMap.has(t),
        calEntry: cal.find((e) => e.symbol === t) ?? null,
      }));
      return json({
        debug: true,
        window: { from, to, days },
        finnhubKeyPresent: FINNHUB_KEY.length > 0,
        calendarCount: cal.length,
        calendarSample: cal.slice(0, 20).map((e) => ({ s: e.symbol, d: e.date, h: e.hour })),
        reliabilityCount: relMap.size,
        candidatesAfterFilter: candidates.length,
        candidateSymbols: candidates.map((c) => c.symbol),
        builtNonNull: results.length,
        builtNullSymbols: candidates.filter((_, i) => built[i] == null).map((c) => c.symbol),
        probe,
      });
    }

    const payload = { generatedAt: new Date().toISOString(), window: cacheKey, count: results.length, results, cached: false };
    await sb.from("earnings_scan_cache").upsert({ id: cacheKey, payload, created_at: new Date().toISOString() });
    return json(payload);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
