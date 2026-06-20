// Supabase Edge Function: income-scanner
// The "producer" for the Income Scanner — finds cash-secured-put income drivers.
//
//   1. Read the curated income_universe table (small, liquid, low-priced names).
//   2. For each name pull the live CBOE delayed (~15 min) option chain + Yahoo
//      historical vol + the next Finnhub earnings date.
//   3. Emit, per name, the PUT chain BAND (|delta| 0.05-0.45, DTE 5-65) with
//      greeks so the client can re-pick strike/expiration as the user drags the
//      delta/DTE sliders — no re-fetch needed.
//   4. Cache the whole payload (income_scan_cache). The function serves the cache
//      when it is younger than CACHE_TTL_MS; the UI "Refresh" button calls with
//      force=true to recompute live. All filtering/ranking (price < $15, IV/HV
//      floor, earnings exclusion, diversification, top-20) happens client-side.
//
// This is the "lazy" producer: the heavy fetch runs on the first request after
// the cache goes stale (~5-10s). To make every load instant instead, schedule
// this function on a 15-min cron — see docs/income-scanner.md.
//
// Deploy:  supabase functions deploy income-scanner
// Secrets: FINNHUB_API_KEY (already set for market-data)

import { createClient } from "jsr:@supabase/supabase-js@2";

const FINNHUB_KEY = Deno.env.get("FINNHUB_API_KEY") ?? "";
const FINNHUB = "https://finnhub.io/api/v1";
const CBOE = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const YCHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CACHE_TTL_MS = 15 * 60 * 1000;   // 15 min (matches CBOE's data delay)
const MAX_SPOT = 30;                    // skip names trading well above the $15 cutoff
const DTE_MIN = 5;
const DTE_MAX = 65;
const DELTA_MIN = 0.05;                 // put-chain band kept for client strike selection
const DELTA_MAX = 0.45;

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

const normIv = (x: number) => (x > 3 ? x / 100 : x); // CBOE iv may be % or decimal

type Contract = {
  cp: "C" | "P"; strike: number; expUnix: number;
  bid: number; ask: number; last: number; iv: number; delta: number; vol: number; oi: number;
};
function mid(c: Contract): number {
  if (c.bid > 0 && c.ask > 0) return (c.bid + c.ask) / 2;
  return c.last > 0 ? c.last : (c.ask > 0 ? c.ask / 2 : 0);
}

// Parse an OCC option symbol, e.g. "F     260618P00012000" -> Put, 2026-06-18, strike 12.
function parseOcc(occ: string): { cp: "C" | "P"; strike: number; expUnix: number } | null {
  if (occ.length < 16) return null;
  const strikeRaw = occ.slice(-8), cp = occ.slice(-9, -8);
  const yy = occ.slice(-15, -13), mm = occ.slice(-13, -11), dd = occ.slice(-11, -9);
  if ((cp !== "C" && cp !== "P") || !/^\d{6}$/.test(yy + mm + dd) || !/^\d{8}$/.test(strikeRaw)) return null;
  return { cp, strike: +strikeRaw / 1000, expUnix: Math.floor(Date.UTC(2000 + +yy, +mm - 1, +dd) / 1000) };
}

// Live CBOE delayed chain: spot + parsed puts (we only need puts for CSPs).
async function cboePuts(sym: string): Promise<{ spot: number; puts: Contract[] } | null> {
  const r = await fetch(`${CBOE}/${encodeURIComponent(sym)}.json`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const d = await r.json();
  const data = d?.data;
  if (!data || !Array.isArray(data.options)) return null;
  const puts: Contract[] = [];
  for (const o of data.options) {
    const p = parseOcc(String(o.option ?? ""));
    if (!p || p.cp !== "P") continue;
    puts.push({
      cp: "P", strike: p.strike, expUnix: p.expUnix,
      bid: +(o.bid ?? 0), ask: +(o.ask ?? 0), last: +(o.last_trade_price ?? 0),
      iv: normIv(+(o.iv ?? 0)), delta: +(o.delta ?? 0), vol: +(o.volume ?? 0), oi: +(o.open_interest ?? 0),
    });
  }
  return { spot: +(data.current_price ?? 0), puts };
}

// Annualized 30-day historical vol from Yahoo daily candles.
async function annualizedHv(sym: string): Promise<number> {
  try {
    const r = await fetch(`${YCHART}/${sym}?range=3mo&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return 0.5;
    const d = await r.json();
    const closes = (d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [])
      .filter((x: number | null): x is number => typeof x === "number");
    if (closes.length < 21) return 0.5;
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    const recent = rets.slice(-30);
    const m = recent.reduce((a, b) => a + b, 0) / recent.length;
    const v = recent.reduce((a, b) => a + (b - m) ** 2, 0) / recent.length;
    return (Math.sqrt(v) || 0.03) * Math.sqrt(252);
  } catch {
    return 0.5;
  }
}

// Next earnings date (ISO) on/after today for each symbol, from Finnhub's calendar.
async function nextEarnings(fromISO: string, toISO: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const r = await fetch(`${FINNHUB}/calendar/earnings?from=${fromISO}&to=${toISO}&token=${FINNHUB_KEY}`);
    const d = await r.json();
    for (const e of (d?.earningsCalendar ?? []) as Array<{ symbol: string; date: string }>) {
      if (!e.symbol || !e.date) continue;
      const prev = out.get(e.symbol);
      if (!prev || e.date < prev) out.set(e.symbol, e.date); // earliest upcoming
    }
  } catch { /* earnings flag is best-effort */ }
  return out;
}

type PutRow = { strike: number; delta: number; mid: number; iv: number; vol: number; oi: number };
type ExpRow = { expiration: string; dte: number; puts: PutRow[] };
type NameRow = {
  ticker: string; sector: string; beta: number; spot: number; hv: number;
  earnings: string | null; expirations: ExpRow[];
};

async function buildName(u: { ticker: string; sector: string; beta: number }, earnAt: string | null): Promise<NameRow | null> {
  const chain = await cboePuts(u.ticker);
  if (!chain || chain.spot <= 0 || chain.spot > MAX_SPOT || !chain.puts.length) return null;
  const hv = await annualizedHv(u.ticker);

  const now = Date.now();
  const byExp = new Map<number, Contract[]>();
  for (const p of chain.puts) {
    const dte = Math.round((p.expUnix * 1000 - now) / 86400000);
    if (dte < DTE_MIN || dte > DTE_MAX) continue;
    const ad = Math.abs(p.delta);
    if (ad < DELTA_MIN || ad > DELTA_MAX || mid(p) <= 0) continue;
    const arr = byExp.get(p.expUnix) ?? [];
    arr.push(p);
    byExp.set(p.expUnix, arr);
  }
  if (byExp.size === 0) return null;

  const expirations: ExpRow[] = [...byExp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([expUnix, list]) => ({
      expiration: new Date(expUnix * 1000).toISOString().slice(0, 10),
      dte: Math.round((expUnix * 1000 - now) / 86400000),
      puts: list
        .map((c) => ({
          strike: c.strike,
          delta: +Math.abs(c.delta).toFixed(3),
          mid: +mid(c).toFixed(2),
          iv: +c.iv.toFixed(4),
          vol: c.vol,
          oi: c.oi,
        }))
        .sort((a, b) => a.strike - b.strike),
    }));

  return {
    ticker: u.ticker, sector: u.sector, beta: u.beta,
    spot: +chain.spot.toFixed(2), hv: +hv.toFixed(4),
    earnings: earnAt, expirations,
  };
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const force = !!body.force;
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    if (!force) {
      const { data: cached } = await sb.from("income_scan_cache").select("payload, created_at").eq("id", "default").maybeSingle();
      if (cached && Date.now() - new Date(cached.created_at).getTime() < CACHE_TTL_MS) {
        return json({ ...cached.payload, cached: true });
      }
    }

    const { data: universe } = await sb.from("income_universe").select("ticker, sector, beta").eq("active", true);
    const names = (universe ?? []) as Array<{ ticker: string; sector: string; beta: number }>;
    if (names.length === 0) return json({ error: "income_universe is empty — seed it first" }, 400);

    const today = new Date();
    const fromISO = today.toISOString().slice(0, 10);
    const toISO = new Date(today.getTime() + (DTE_MAX + 5) * 86400000).toISOString().slice(0, 10);
    const earnMap = await nextEarnings(fromISO, toISO);

    const built = await pool(names, 6, (u) =>
      buildName(u, earnMap.get(u.ticker) ?? null).catch(() => null),
    );
    const results = built.filter((x): x is NameRow => x != null);

    const payload = { generatedAt: new Date().toISOString(), count: results.length, names: results, cached: false };
    await sb.from("income_scan_cache").upsert({ id: "default", payload, created_at: new Date().toISOString() });
    return json(payload);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
