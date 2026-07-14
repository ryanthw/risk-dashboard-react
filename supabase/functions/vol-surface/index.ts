// Supabase Edge Function: vol-surface
// Per-ticker implied-vol term structure for the Basis Tracker.
//
//   1. Discover upcoming expirations (+ spot) from the CBOE delayed chain —
//      one fast unauthenticated call. (Public's option-chain endpoint needs an
//      explicit expirationDate, so discovery has to come from elsewhere.)
//   2. PRIMARY: pull each expiration's chain from the Public API (live greeks)
//      and reduce it to ATM IV, 25Δ put/call IV and the expected move. Also
//      returns live marks for any specific long-call contracts the caller
//      holds, and the best-yielding ~25Δ covered-call candidate across the
//      5-45 DTE window ("what would covering pay").
//   3. FALLBACK: if Public auth/data fails, the same reduction runs on the
//      DoltHub post-no-preference/options chain (~15-min delayed EOD greeks).
//   4. Next earnings date via Finnhub. Payload cached per ticker for 15 min
//      (vol_surface_cache) so tab visits don't hammer the APIs.
//
// Deploy:  supabase functions deploy vol-surface
// Secrets: PUBLI_API_KEY (note: no C — matches ~/.zshrc), FINNHUB_API_KEY

import { createClient } from "jsr:@supabase/supabase-js@2";

const PUBLIC_KEY = Deno.env.get("PUBLI_API_KEY") ?? "";
const PUBLIC_BASE = "https://api.public.com/userapigateway";
const PUBLIC_AUTH = "https://api.public.com/userapiauthservice/personal/access-tokens";
const PUBLIC_ACCT = Deno.env.get("PUBLIC_ACCOUNT_ID") ?? "";
const CBOE = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const DOLT = "https://www.dolthub.com/api/v1alpha1/post-no-preference/options/master";
const FINNHUB_KEY = Deno.env.get("FINNHUB_API_KEY") ?? "";
const FINNHUB = "https://finnhub.io/api/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CACHE_TTL_MS = 15 * 60 * 1000;
const DTE_MIN = 3;
const DTE_MAX = 130;
const MAX_EXPIRATIONS = 8;
const CC_DTE_LO = 5; // covered-call candidate window
const CC_DTE_HI = 45;
const CC_TARGET_DELTA = 0.25;

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

// ---- shared row shape both sources reduce to --------------------------------
type Row = {
  strike: number;
  cp: "C" | "P";
  iv: number; // decimal
  delta: number; // signed
  mid: number;
};

type ExpSummary = {
  expiration: string;
  dte: number;
  atmIv: number;
  put25Iv: number | null;
  call25Iv: number | null;
  /** ATM-IV expected move to expiration, as a fraction of spot. */
  expectedMovePct: number;
};

type ContractQuote = {
  expiration: string;
  strike: number;
  mid: number;
  delta: number;
  iv: number;
};

type CcCandidate = {
  expiration: string;
  dte: number;
  strike: number;
  delta: number;
  mid: number;
  /** Annualized premium yield on spot (mid/spot * 365/dte). */
  annYield: number;
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

/** Reduce one expiration's rows to ATM/25Δ IV + expected move. */
function summarize(expiration: string, rows: Row[], spot: number): ExpSummary | null {
  const withIv = rows.filter((r) => r.iv > 0);
  if (!withIv.length || spot <= 0) return null;
  const dte = dteOf(expiration);

  const atmCall = nearestBy(withIv.filter((r) => r.cp === "C"), (r) => r.strike, spot);
  const atmPut = nearestBy(withIv.filter((r) => r.cp === "P"), (r) => r.strike, spot);
  const atmIvs = [atmCall?.iv, atmPut?.iv].filter((x): x is number => x != null && x > 0);
  if (!atmIvs.length) return null;
  const atmIv = atmIvs.reduce((a, b) => a + b, 0) / atmIvs.length;

  const p25 = nearestBy(withIv.filter((r) => r.cp === "P" && r.delta !== 0), (r) => Math.abs(r.delta), 0.25);
  const c25 = nearestBy(withIv.filter((r) => r.cp === "C" && r.delta !== 0), (r) => Math.abs(r.delta), 0.25);

  return {
    expiration,
    dte,
    atmIv: +atmIv.toFixed(4),
    put25Iv: p25 ? +p25.iv.toFixed(4) : null,
    call25Iv: c25 ? +c25.iv.toFixed(4) : null,
    expectedMovePct: +(atmIv * Math.sqrt(Math.max(dte, 0) / 365)).toFixed(4),
  };
}

/**
 * Best covered-call candidate: for every expiration in the 5-45 DTE window,
 * take the call nearest 0.25Δ, then keep the one with the highest annualized
 * premium yield on spot. Earnings inside the window are NOT excluded — the
 * card's earnings flag makes that risk explicit and it stays the user's call.
 */
function pickCcCandidate(byExp: Map<string, Row[]>, spot: number): CcCandidate | null {
  let best: CcCandidate | null = null;
  for (const [e, rows] of byExp) {
    const dte = dteOf(e);
    if (dte < CC_DTE_LO || dte > CC_DTE_HI) continue;
    const calls = rows.filter(
      (r) => r.cp === "C" && r.delta > 0 && r.mid > 0 && r.strike >= spot,
    );
    const pick = nearestBy(calls, (r) => r.delta, CC_TARGET_DELTA);
    if (!pick) continue;
    const annYield = (pick.mid / spot) * (365 / Math.max(dte, 1));
    if (!best || annYield > best.annYield) {
      best = {
        expiration: e,
        dte,
        strike: pick.strike,
        delta: +pick.delta.toFixed(3),
        mid: +pick.mid.toFixed(2),
        annYield: +annYield.toFixed(4),
      };
    }
  }
  return best;
}

// ---- expiration discovery via CBOE ------------------------------------------
function parseOcc(occ: string): { cp: "C" | "P"; strike: number; exp: string } | null {
  if (occ.length < 16) return null;
  const strikeRaw = occ.slice(-8), cp = occ.slice(-9, -8);
  const yy = occ.slice(-15, -13), mm = occ.slice(-13, -11), dd = occ.slice(-11, -9);
  if ((cp !== "C" && cp !== "P") || !/^\d{6}$/.test(yy + mm + dd) || !/^\d{8}$/.test(strikeRaw)) return null;
  return { cp, strike: +strikeRaw / 1000, exp: `20${yy}-${mm}-${dd}` };
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

// ---- PRIMARY: Public API (live greeks) --------------------------------------
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

// ---- FALLBACK: DoltHub (~15-min delayed) -------------------------------------
async function doltQuery(sql: string): Promise<Array<Record<string, unknown>> | null> {
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(`${DOLT}?q=${encodeURIComponent(sql)}`, {
        headers: { "User-Agent": "risk-dashboard" },
      });
      const d = await r.json();
      if (d?.query_execution_status === "Success") return d.rows ?? [];
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 500 * (k + 1)));
  }
  return null;
}

async function doltChains(sym: string, exps: string[]): Promise<Map<string, Row[]> | null> {
  if (!exps.length) return null;
  const expList = exps.map((e) => `'${e}'`).join(",");
  // A MAX(date) subquery times out on the DoltHub API; probe recent dates with
  // indexed equality lookups instead (chains are stamped on trading days).
  let rows: Array<Record<string, unknown>> | null = null;
  for (let back = 0; back < 8 && (!rows || !rows.length); back++) {
    const day = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
    rows = await doltQuery(
      `SELECT expiration, strike, call_put, bid, ask, vol, delta FROM option_chain ` +
        `WHERE act_symbol='${sym}' AND date='${day}' AND expiration IN (${expList})`,
    );
  }
  if (!rows || !rows.length) return null;
  const byExp = new Map<string, Row[]>();
  for (const r of rows) {
    const exp = String(r.expiration).slice(0, 10);
    const bid = num(r.bid), ask = num(r.ask);
    const row: Row = {
      strike: num(r.strike),
      cp: String(r.call_put).startsWith("C") ? "C" : "P",
      iv: num(r.vol),
      delta: num(r.delta),
      mid: ask > 0 ? (bid > 0 ? (bid + ask) / 2 : ask / 2) : 0,
    };
    if (row.strike <= 0) continue;
    const arr = byExp.get(exp) ?? [];
    arr.push(row);
    byExp.set(exp, arr);
  }
  return byExp;
}

// ---- earnings ----------------------------------------------------------------
async function nextEarnings(sym: string): Promise<string | null> {
  if (!FINNHUB_KEY) return null;
  try {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
    const r = await fetch(
      `${FINNHUB}/calendar/earnings?from=${from}&to=${to}&symbol=${sym}&token=${FINNHUB_KEY}`,
    );
    const d = await r.json();
    const dates = ((d?.earningsCalendar ?? []) as Array<{ date?: string }>)
      .map((e) => e.date)
      .filter((x): x is string => !!x)
      .sort();
    return dates[0] ?? null;
  } catch {
    return null;
  }
}

// ---- handler -------------------------------------------------------------------
type Payload = {
  ticker: string;
  spot: number;
  source: "public" | "dolthub";
  asOf: string;
  earnings: string | null;
  expirations: ExpSummary[];
  contracts: ContractQuote[];
  ccCandidate: CcCandidate | null;
  cached: boolean;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const ticker = String(body.ticker ?? "").toUpperCase();
    if (!ticker) return json({ error: "ticker required" }, 400);
    const force = !!body.force;
    // Specific long-call contracts to quote: [{expiration, strike}]
    const wanted: Array<{ expiration: string; strike: number }> = Array.isArray(body.contracts)
      ? body.contracts
          .map((c: Record<string, unknown>) => ({
            expiration: String(c.expiration ?? "").slice(0, 10),
            strike: num(c.strike),
          }))
          .filter((c: { expiration: string; strike: number }) => c.expiration && c.strike > 0)
      : [];

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    if (!force) {
      const { data: cached } = await sb
        .from("vol_surface_cache")
        .select("payload, created_at")
        .eq("ticker", ticker)
        .maybeSingle();
      if (cached && Date.now() - new Date(cached.created_at).getTime() < CACHE_TTL_MS) {
        const p = cached.payload as Payload;
        // Serve the cache only if it already covers every requested contract.
        const covered = wanted.every((w) =>
          p.contracts?.some((c) => c.expiration === w.expiration && c.strike === w.strike),
        );
        if (covered) return json({ ...p, cached: true });
      }
    }

    const disc = await cboeDiscover(ticker);
    if (!disc || !disc.expirations.length) {
      return json({ error: `no option chain found for ${ticker}` }, 404);
    }
    const spot = disc.spot;

    const near = disc.expirations
      .map((e) => ({ e, dte: dteOf(e) }))
      .filter((x) => x.dte >= DTE_MIN && x.dte <= DTE_MAX)
      .slice(0, MAX_EXPIRATIONS)
      .map((x) => x.e);
    const targetExps = [...new Set([...near, ...wanted.map((w) => w.expiration)])].sort();

    // PRIMARY: Public live greeks; FALLBACK: DoltHub.
    let byExp: Map<string, Row[]> | null = null;
    let source: "public" | "dolthub" = "public";
    try {
      if (!PUBLIC_KEY) throw new Error("PUBLI_API_KEY not set");
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
      if (chains.size === 0) throw new Error("public returned no chains");
      byExp = chains;
    } catch {
      source = "dolthub";
      byExp = await doltChains(ticker, targetExps);
    }
    if (!byExp || byExp.size === 0) {
      return json({ error: `no vol data for ${ticker} from Public or DoltHub` }, 502);
    }

    const expirations = [...byExp.entries()]
      .map(([e, rows]) => summarize(e, rows, spot))
      .filter((x): x is ExpSummary => x != null && x.dte >= 0)
      .sort((a, b) => a.dte - b.dte);

    const contracts: ContractQuote[] = [];
    for (const w of wanted) {
      const rows = byExp.get(w.expiration);
      const hit = rows?.find((r) => r.cp === "C" && Math.abs(r.strike - w.strike) < 0.005);
      if (hit) {
        contracts.push({
          expiration: w.expiration,
          strike: w.strike,
          mid: +hit.mid.toFixed(2),
          delta: +hit.delta.toFixed(3),
          iv: +hit.iv.toFixed(4),
        });
      }
    }

    const payload: Payload = {
      ticker,
      spot: +spot.toFixed(2),
      source,
      asOf: new Date().toISOString(),
      earnings: await nextEarnings(ticker),
      expirations,
      contracts,
      ccCandidate: pickCcCandidate(byExp, spot),
      cached: false,
    };

    await sb.from("vol_surface_cache").upsert({
      ticker,
      payload,
      created_at: new Date().toISOString(),
    });
    return json(payload);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
