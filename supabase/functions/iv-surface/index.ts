// Supabase Edge Function: iv-surface
// Full delta-bucketed IV surface for the IV Surface tab (SPY only).
//
//   1. Discover expirations (+ spot) from the CBOE delayed chain — Public's
//      option-chain endpoint needs an explicit expirationDate.
//   2. Keep EVERY listed expiration 5-40 DTE (the strategy never trades past
//      40 DTE; SPY dailies cover roughly the first two weeks and matter for
//      front-leg selection, so no expiration cap).
//   3. Pull each expiration's chain from the Public API (live greeks) and
//      reduce it to fixed delta buckets (15Δ-50Δ, puts and calls) carrying
//      strike/IV/mid/vega/theta so the client can price double-diagonal
//      candidates without re-fetching.
//   4. Payload cached 15 min (iv_surface_cache); `force: true` bypasses.
//
// Deploy:  supabase functions deploy iv-surface
// Secrets: PUBLI_API_KEY (note: no C — matches ~/.zshrc)

import { createClient } from "jsr:@supabase/supabase-js@2";

const PUBLIC_KEY = Deno.env.get("PUBLI_API_KEY") ?? "";
const PUBLIC_BASE = "https://api.public.com/userapigateway";
const PUBLIC_AUTH = "https://api.public.com/userapiauthservice/personal/access-tokens";
const PUBLIC_ACCT = Deno.env.get("PUBLIC_ACCOUNT_ID") ?? "";
const CBOE = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALLOWED_TICKERS = new Set(["SPY"]);
const CACHE_TTL_MS = 15 * 60 * 1000;
// Inside ~5 DTE the quoted IV is dominated by pin/settlement effects and the
// wings blow out to numbers that aren't a tradable vol level — a front leg that
// close is pure gamma, not a diagonal. Floor the whole surface there so the
// heatmap and the pair scan see the same expirations.
const DTE_MIN = 5;
const DTE_MAX = 40;
// |delta| targets for both wings. 50Δ ≈ ATM anchor; 15Δ is as far out as the
// wings stay quotable on the dailies.
const DELTA_TARGETS = [0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15];
const DELTA_TOLERANCE = 0.06; // bucket is null if no contract lands this close

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

const num = (x: unknown): number => {
  const n = typeof x === "string" ? parseFloat(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? n : 0;
};

// ---- payload shapes (mirrored in src/api/ivSurface.ts) -----------------------
type BucketRow = {
  b: string; // e.g. "P35" = put nearest |0.35| delta
  strike: number;
  delta: number; // signed, as quoted
  iv: number; // decimal
  mid: number; // per share
  vega: number;
  theta: number;
  oi: number;
};

type SurfaceExpiration = {
  expiration: string;
  dte: number;
  atmIv: number;
  buckets: BucketRow[];
};

type Payload = {
  ticker: string;
  spot: number;
  asOf: string;
  expirations: SurfaceExpiration[];
  cached: boolean;
};

type Row = {
  strike: number;
  cp: "C" | "P";
  iv: number;
  delta: number;
  mid: number;
  bid: number;
  vega: number;
  theta: number;
  oi: number;
};

function dteOf(expIso: string, now = Date.now()): number {
  return Math.round((new Date(`${expIso}T16:00:00Z`).getTime() - now) / 86400000);
}

function nearestBy<T>(items: T[], key: (t: T) => number, target: number): T | null {
  let best: T | null = null;
  let bd = Infinity;
  for (const it of items) {
    const d = Math.abs(key(it) - target);
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}

// ---- expiration discovery via CBOE ------------------------------------------
function parseOcc(occ: string): { exp: string } | null {
  if (occ.length < 16) return null;
  const cp = occ.slice(-9, -8);
  const yy = occ.slice(-15, -13), mm = occ.slice(-13, -11), dd = occ.slice(-11, -9);
  if ((cp !== "C" && cp !== "P") || !/^\d{6}$/.test(yy + mm + dd)) return null;
  return { exp: `20${yy}-${mm}-${dd}` };
}

async function cboeDiscover(sym: string): Promise<{ spot: number; expirations: string[] } | null> {
  const r = await fetch(`${CBOE}/${encodeURIComponent(sym)}.json`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) return null;
  const d = await r.json();
  const data = d?.data;
  if (!data || !Array.isArray(data.options)) return null;
  const exps = new Set<string>();
  for (const o of data.options) {
    const p = parseOcc(String(o.option ?? ""));
    if (p) exps.add(p.exp);
  }
  return { spot: num(data.current_price), expirations: [...exps].sort() };
}

// ---- Public API (live greeks) -------------------------------------------------
async function publicToken(): Promise<string> {
  const r = await fetch(PUBLIC_AUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ validityInMinutes: 10, secret: PUBLIC_KEY }),
  });
  if (!r.ok) throw new Error(`public auth ${r.status}`);
  const d = await r.json();
  if (!d?.accessToken) throw new Error("public auth: no accessToken");
  return d.accessToken;
}

// deno-lint-ignore no-explicit-any
function publicRows(side: any[], cp: "C" | "P"): Row[] {
  const out: Row[] = [];
  for (const c of side ?? []) {
    const det = c?.optionDetails ?? {};
    const g = det.greeks ?? {};
    const bid = num(c.bid), ask = num(c.ask);
    const mid = num(det.midPrice) || (bid > 0 && ask > 0 ? (bid + ask) / 2 : num(c.last));
    out.push({
      strike: num(det.strikePrice),
      cp,
      iv: num(g.impliedVolatility),
      delta: num(g.delta),
      mid,
      bid,
      vega: num(g.vega),
      theta: num(g.theta),
      oi: num(c.openInterest),
    });
  }
  return out.filter((r) => r.strike > 0);
}

async function publicChain(sym: string, exp: string, tok: string): Promise<Row[] | null> {
  const r = await fetch(`${PUBLIC_BASE}/marketdata/${PUBLIC_ACCT}/option-chain`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      instrument: { symbol: sym, type: "EQUITY" },
      expirationDate: exp,
    }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  if (!Array.isArray(d?.calls) && !Array.isArray(d?.puts)) return null;
  return [...publicRows(d?.calls ?? [], "C"), ...publicRows(d?.puts ?? [], "P")];
}

// ---- reduce one chain to the delta-bucket grid --------------------------------
function reduceChain(expiration: string, rows: Row[], spot: number): SurfaceExpiration | null {
  // No-bid or IV-less rows are stale wings that would paint garbage on the
  // heatmap edges; drop them before bucketing.
  const live = rows.filter((r) => r.iv > 0 && r.bid > 0 && Math.abs(r.delta) > 0.02);
  if (!live.length || spot <= 0) return null;

  const atmCall = nearestBy(live.filter((r) => r.cp === "C"), (r) => r.strike, spot);
  const atmPut = nearestBy(live.filter((r) => r.cp === "P"), (r) => r.strike, spot);
  const atmIvs = [atmCall?.iv, atmPut?.iv].filter((x): x is number => x != null && x > 0);
  if (!atmIvs.length) return null;

  const buckets: BucketRow[] = [];
  for (const cp of ["P", "C"] as const) {
    const side = live.filter((r) => r.cp === cp);
    for (const t of DELTA_TARGETS) {
      const hit = nearestBy(side, (r) => Math.abs(r.delta), t);
      if (!hit || Math.abs(Math.abs(hit.delta) - t) > DELTA_TOLERANCE) continue;
      buckets.push({
        b: `${cp}${Math.round(t * 100)}`,
        strike: hit.strike,
        delta: +hit.delta.toFixed(4),
        iv: +hit.iv.toFixed(4),
        mid: +hit.mid.toFixed(3),
        vega: +hit.vega.toFixed(4),
        theta: +hit.theta.toFixed(4),
        oi: hit.oi,
      });
    }
  }
  if (!buckets.length) return null;

  return {
    expiration,
    dte: dteOf(expiration),
    atmIv: +(atmIvs.reduce((a, b) => a + b, 0) / atmIvs.length).toFixed(4),
    buckets,
  };
}

// ---- handler -------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const ticker = String(body.ticker ?? "SPY").toUpperCase();
    if (!ALLOWED_TICKERS.has(ticker)) {
      return json({ error: `iv-surface is gated to ${[...ALLOWED_TICKERS].join(", ")}` }, 400);
    }
    const force = !!body.force;

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    if (!force) {
      // Cache miss/table-missing both fall through to a live pull.
      try {
        const { data: cached } = await sb
          .from("iv_surface_cache")
          .select("payload, created_at")
          .eq("ticker", ticker)
          .maybeSingle();
        if (cached && Date.now() - new Date(cached.created_at).getTime() < CACHE_TTL_MS) {
          return json({ ...(cached.payload as Payload), cached: true });
        }
      } catch { /* serve live */ }
    }

    if (!PUBLIC_KEY) return json({ error: "PUBLI_API_KEY not set" }, 500);

    const disc = await cboeDiscover(ticker);
    if (!disc || !disc.expirations.length) {
      return json({ error: `no option chain found for ${ticker}` }, 404);
    }

    const targetExps = disc.expirations.filter((e) => {
      const dte = dteOf(e);
      return dte >= DTE_MIN && dte <= DTE_MAX;
    });
    if (!targetExps.length) {
      return json({ error: `no expirations in the ${DTE_MIN}-${DTE_MAX} DTE window` }, 404);
    }

    const tok = await publicToken();
    const chains = new Map<string, Row[]>();
    // Small sequential pool (4 at a time) to stay polite.
    for (let i = 0; i < targetExps.length; i += 4) {
      const batch = targetExps.slice(i, i + 4);
      const res = await Promise.all(batch.map((e) => publicChain(ticker, e, tok)));
      batch.forEach((e, j) => {
        const rows = res[j];
        if (rows && rows.length) chains.set(e, rows);
      });
    }
    if (chains.size === 0) return json({ error: "Public returned no chains" }, 502);

    const expirations = [...chains.entries()]
      .map(([e, rows]) => reduceChain(e, rows, disc.spot))
      .filter((x): x is SurfaceExpiration => x != null)
      .sort((a, b) => a.dte - b.dte);

    const payload: Payload = {
      ticker,
      spot: +disc.spot.toFixed(2),
      asOf: new Date().toISOString(),
      expirations,
      cached: false,
    };

    try {
      await sb.from("iv_surface_cache").upsert({
        ticker,
        payload,
        created_at: new Date().toISOString(),
      });
    } catch { /* cache write is best-effort */ }

    return json(payload);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
