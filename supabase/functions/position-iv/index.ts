// Supabase Edge Function: position-iv
// Marks the open book's implied vol, one chain read per (ticker, expiration).
//
// `trades.iv` was static for a position's whole life, so every model that falls
// out of it — BS value, greeks, POP, VaR/CVaR, Kelly, the payoff curves — was
// answering "what did this look like the day I opened it", not "what is this
// worth now". This resolves a current IV per position instead.
//
// The hard part is not fetching it, it is deciding when to believe it. A short
// OTM put quoted 0.05 / 0.35 implies wildly different vols at bid and at ask,
// and that spread is the norm for exactly the contracts a wheel book holds to
// expiry. So a quoted IV is taken only when the quote is tradeable, and
// otherwise the level is rebuilt from a point that is always liquid:
//
//   1. contract   the contract's own IV, if its quote passes every gate below
//   2. atm_skew   ATM IV x this position's iv/atm ratio. Skew at a fixed strike
//                 drifts far more slowly than the vol level does, so an illiquid
//                 wing still tracks the surface it sits on. The ratio comes from
//                 the last trusted read of this contract, or — for one that has
//                 never had a trusted read, because it is quoted too wide or is
//                 not listed on this expiration — from the nearest strike whose
//                 quote is sound. Without that seeding, a permanently illiquid
//                 position could never reach this tier at all: the only thing
//                 that stores a ratio is a tier-1 success, so it would hold a
//                 stale mark forever, exactly where the mark is least reliable.
//   3. last_good  hold the previous value. Honest when there is nothing to read.
//
// Realized vol is deliberately NOT a fallback. Implied runs above realized the
// large majority of the time, so marking a short-premium book at HV understates
// every short option's value and overstates unrealized gain on every one of
// them — a bias pointed the wrong way for this book in particular.
//
// This function resolves and returns; it does not write. refreshPortfolio owns
// the write, so `trades` keeps a single writer.
//
// Deploy:  supabase functions deploy position-iv
// Secrets: PUBLI_API_KEY, PUBLIC_ACCOUNT_ID  (both already set for iv-surface)

const PUBLIC_KEY = Deno.env.get("PUBLI_API_KEY") ?? "";
const PUBLIC_BASE = "https://api.public.com/userapigateway";
const PUBLIC_AUTH = "https://api.public.com/userapiauthservice/personal/access-tokens";
const PUBLIC_ACCT = Deno.env.get("PUBLIC_ACCOUNT_ID") ?? "";

// Inside this many days the quoted vol is dominated by pin and settlement
// effects and the wings blow out to numbers that aren't a tradable level —
// the same floor iv-surface puts on the whole surface. Vega is negligible here
// anyway, so holding the previous mark costs almost nothing.
const DTE_MIN = 5;
// (ask - bid) / mid above this and the midpoint isn't a price anyone trades at,
// so the vol implied from it isn't a vol anyone trades at either.
const MAX_REL_SPREAD = 0.30;
// A contract's IV this far from its own expiration's ATM is a quote artifact,
// not skew. Generous on the high side: real put skew on a small cap gets steep.
const SKEW_BAND_LO = 0.4;
const SKEW_BAND_HI = 3.0;
// How far a neighbouring strike may sit from the position's own before its skew
// stops being a fair stand-in, as a fraction of the position's strike. An
// adjacent listed strike is a good proxy; extrapolating a deep-ITM LEAP's vol
// from the nearest quotable contract several strikes away is not.
const MAX_NEIGHBOUR_STRIKE_GAP = 0.20;
// Concurrent chain reads. The book is small; this is politeness, not throughput.
const CONCURRENCY = 4;

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
  const n = typeof x === "number" ? x : parseFloat(String(x ?? ""));
  return Number.isFinite(n) ? n : 0;
};

type Right = "C" | "P";
type IvSource = "contract" | "atm_skew" | "last_good";

interface PositionReq {
  id: string;
  ticker: string;
  expiration: string;      // ISO date
  strike: number;
  right: Right;
  iv: number;              // current stored value, returned as-is on last_good
  iv_skew_ratio: number | null;
}

interface Resolved {
  id: string;
  iv: number;
  source: IvSource;
  atm_iv: number | null;
  /** Refreshed only on a trusted contract read, so it tracks skew drift. */
  skew_ratio: number | null;
  /** Why the contract's own quote was not used. Null when it was. */
  reason: string | null;
}

interface Row {
  strike: number;
  cp: Right;
  iv: number;
  delta: number;
  bid: number;
  ask: number;
  mid: number;
}

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

// ---- Public API --------------------------------------------------------------
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
function rowsFrom(side: any[], cp: Right): Row[] {
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
      bid,
      ask,
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
  return [...rowsFrom(d?.calls ?? [], "C"), ...rowsFrom(d?.puts ?? [], "P")];
}

/**
 * ATM IV for one expiration, anchored at |delta| = 0.5 rather than at the strike
 * nearest spot. Delta already folds in time and vol, so it finds the true ATM
 * on a skewed or fast-moving name — and it means this function never needs a
 * spot price, so there is no second data source to keep in sync.
 *
 * Averaged across the call and the put: put-call parity says they should agree,
 * and where they don't the mean is the better estimate of the level.
 */
function atmIvOf(live: Row[]): number | null {
  const c = nearestBy(live.filter((r) => r.cp === "C"), (r) => Math.abs(r.delta), 0.5);
  const p = nearestBy(live.filter((r) => r.cp === "P"), (r) => Math.abs(r.delta), 0.5);
  const ivs = [c?.iv, p?.iv].filter((x): x is number => x != null && x > 0);
  if (!ivs.length) return null;
  return ivs.reduce((a, b) => a + b, 0) / ivs.length;
}

/**
 * Is this quote worth reading a vol level off? Shared by tier 1 and by the
 * skew bootstrap, so a contract can never be trusted to seed a ratio on terms
 * stricter or looser than the ones that would let it be used directly.
 */
function quoteIsSound(r: Row, atm: number | null): boolean {
  const relSpread = r.mid > 0 ? (r.ask - r.bid) / r.mid : Infinity;
  if (!(relSpread <= MAX_REL_SPREAD)) return false;
  if (atm != null && (r.iv < atm * SKEW_BAND_LO || r.iv > atm * SKEW_BAND_HI)) return false;
  return true;
}

/**
 * A skew ratio for a position whose own contract cannot supply one — because it
 * is not listed on this expiration, or is quoted too wide to believe.
 *
 * Takes the nearest strike on the same side whose quote *is* sound and uses its
 * iv/atm. Skew is a smooth function of strike, so an adjacent contract is a
 * good local estimate; the distance bound stops that becoming an extrapolation
 * across half the chain.
 *
 * This is what lets a permanently illiquid position reach tier 2 at all. Tier 2
 * needs a stored ratio, the only thing that stored one was a successful tier-1
 * read, and a contract that never passes tier 1 would otherwise sit on
 * last_good forever — going stale precisely where the mark is least reliable.
 */
function bootstrapSkew(
  side: Row[],
  strike: number,
  atm: number | null,
): { ratio: number; from: number } | null {
  if (atm == null || atm <= 0) return null;
  const sound = side.filter((r) => quoteIsSound(r, atm));
  const hit = nearestBy(sound, (r) => r.strike, strike);
  if (!hit) return null;
  if (Math.abs(hit.strike - strike) / strike > MAX_NEIGHBOUR_STRIKE_GAP) return null;
  return { ratio: hit.iv / atm, from: hit.strike };
}

/** Resolve one position against its expiration's chain. */
function resolve(pos: PositionReq, rows: Row[] | null, dte: number): Resolved {
  const held = (reason: string, atm: number | null = null): Resolved => ({
    id: pos.id,
    iv: pos.iv,
    source: "last_good",
    atm_iv: atm,
    skew_ratio: pos.iv_skew_ratio,
    reason,
  });

  if (!rows) return held("chain unavailable");

  // No-bid or IV-less rows are stale listings, not quotes.
  const live = rows.filter((r) => r.iv > 0 && r.bid > 0 && Math.abs(r.delta) > 0.02);
  if (!live.length) return held("no live quotes in chain");

  const atm = atmIvOf(live);

  // Too close to expiry for any quoted vol on this chain to mean anything —
  // including the ATM one, so tier 2 is out here too, not just tier 1.
  if (dte < DTE_MIN) return held(`${dte} DTE — inside the pin window`, atm);

  const side = live.filter((r) => r.cp === pos.right);

  const viaSkew = (reason: string): Resolved => {
    if (atm == null) return held(`${reason}; no ATM anchor either`, null);

    const stored = pos.iv_skew_ratio != null && pos.iv_skew_ratio > 0
      ? { ratio: pos.iv_skew_ratio, note: reason }
      : null;
    const boot = stored ?? (() => {
      const b = bootstrapSkew(side, pos.strike, atm);
      return b ? { ratio: b.ratio, note: `${reason}; skew seeded from K${b.from}` } : null;
    })();

    if (!boot) return held(`${reason}; no sound strike nearby to seed skew from`, atm);
    return {
      id: pos.id,
      iv: +(atm * boot.ratio).toFixed(4),
      source: "atm_skew",
      atm_iv: +atm.toFixed(4),
      skew_ratio: +boot.ratio.toFixed(4),
      reason: boot.note,
    };
  };

  const hit = nearestBy(side, (r) => r.strike, pos.strike);
  if (!hit || Math.abs(hit.strike - pos.strike) >= 0.01) return viaSkew("strike not listed");

  const relSpread = hit.mid > 0 ? (hit.ask - hit.bid) / hit.mid : Infinity;
  if (!(relSpread <= MAX_REL_SPREAD)) {
    return viaSkew(`spread ${(relSpread * 100).toFixed(0)}% of mid`);
  }
  if (atm != null && (hit.iv < atm * SKEW_BAND_LO || hit.iv > atm * SKEW_BAND_HI)) {
    return viaSkew(`IV ${(hit.iv / atm).toFixed(1)}x ATM — outside the skew band`);
  }

  // Trusted read: take it, and re-anchor the skew ratio off it so the fallback
  // stays current instead of frozen at whatever it was at entry.
  return {
    id: pos.id,
    iv: +hit.iv.toFixed(4),
    source: "contract",
    atm_iv: atm == null ? null : +atm.toFixed(4),
    skew_ratio: atm != null && atm > 0 ? +(hit.iv / atm).toFixed(4) : pos.iv_skew_ratio,
    reason: null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!PUBLIC_KEY || !PUBLIC_ACCT) {
    return json({ error: "position-iv is not configured (PUBLI_API_KEY / PUBLIC_ACCOUNT_ID)" }, 500);
  }

  let positions: PositionReq[];
  try {
    const body = await req.json();
    positions = Array.isArray(body?.positions) ? body.positions : [];
  } catch {
    return json({ error: "bad request body" }, 400);
  }
  if (!positions.length) return json({ results: [], failedGroups: [] });

  // One chain read serves every position sharing a ticker and expiration.
  const groups = new Map<string, PositionReq[]>();
  for (const p of positions) {
    if (!p?.ticker || !p?.expiration || !(p.strike > 0)) continue;
    const key = `${p.ticker}|${p.expiration}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(p);
    else groups.set(key, [p]);
  }

  let tok: string;
  try {
    tok = await publicToken();
  } catch (e) {
    return json({ error: `public auth failed: ${(e as Error).message}` }, 502);
  }

  const results: Resolved[] = [];
  const failedGroups: string[] = [];
  const keys = [...groups.keys()];

  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    await Promise.all(
      keys.slice(i, i + CONCURRENCY).map(async (key) => {
        const members = groups.get(key)!;
        const [ticker, expiration] = key.split("|");
        const dte = dteOf(expiration);
        let rows: Row[] | null = null;
        try {
          rows = await publicChain(ticker, expiration, tok);
        } catch {
          rows = null;
        }
        // One bad chain degrades its own positions to last_good and nothing
        // else: a single illiquid name must not stall the whole refresh.
        if (!rows) failedGroups.push(key);
        for (const p of members) results.push(resolve(p, rows, dte));
      }),
    );
  }

  return json({ results, failedGroups });
});
