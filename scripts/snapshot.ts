/**
 * Scheduled portfolio snapshot.
 *
 * Runs the same refresh the app's Refresh button runs, headlessly, so the
 * snapshot series stops depending on someone remembering to click. No browser
 * is involved: the whole path is HTTP — sign in, invoke the market-data edge
 * function, write rows under the user's own RLS.
 *
 * Deliberately strict. It refuses to log a snapshot when any quote was rejected
 * by the sanity guard or failed outright, and exits non-zero so the run shows
 * up as a failure instead of silently poisoning the history. A missing snapshot
 * is a visible gap; a wrong one is indistinguishable from a real observation.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_EMAIL, SUPABASE_PASSWORD.
 * URL and key fall back to their VITE_-prefixed equivalents for local runs.
 */
import { createClient } from "@supabase/supabase-js";
import { refreshPortfolio } from "@/lib/refreshPortfolio";
import type { Portfolio, Trade } from "@/types";

/**
 * Reads the first name that is set. The VITE_-prefixed fallbacks let a local
 * run reuse .env.local instead of duplicating the same URL and key under a
 * second set of names; CI supplies the unprefixed ones as secrets.
 */
function required(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  console.error(`Missing required env var: ${names.join(" or ")}`);
  process.exit(2);
}

const num = (v: unknown) => (v == null ? null : Number(v));

async function main() {
  const url = required("SUPABASE_URL", "VITE_SUPABASE_URL");
  const anonKey = required("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY");
  const email = required("SUPABASE_EMAIL");
  const password = required("SUPABASE_PASSWORD");

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: auth, error: authErr } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (authErr || !auth.user) {
    console.error(`Sign-in failed: ${authErr?.message ?? "no user returned"}`);
    process.exit(1);
  }
  const userId = auth.user.id;
  console.log(`Signed in as ${email}`);

  const { data: pRows, error: pErr } = await client.from("portfolios").select("*");
  if (pErr) {
    console.error(`Could not load portfolios: ${pErr.message}`);
    process.exit(1);
  }
  const portfolios = (pRows ?? []).map((p) => ({
    ...p,
    cash: Number(p.cash),
  })) as Portfolio[];

  if (portfolios.length === 0) {
    console.log("No portfolios; nothing to snapshot.");
    return;
  }

  let failures = 0;

  for (const portfolio of portfolios) {
    const { data: tRows, error: tErr } = await client
      .from("trades")
      .select("*")
      .eq("portfolio_id", portfolio.id);
    if (tErr) {
      console.error(`[${portfolio.name}] could not load trades: ${tErr.message}`);
      failures++;
      continue;
    }

    const trades = (tRows ?? []).map((r) => ({
      ...r,
      qty: Number(r.qty),
      strike: num(r.strike),
      strike_2: num(r.strike_2),
      premium: num(r.premium),
      iv: Number(r.iv),
      underlying_price: num(r.underlying_price),
      cost_basis: num(r.cost_basis),
      beta: Number(r.beta ?? 1),
    })) as Trade[];

    try {
      const report = await refreshPortfolio(client, userId, portfolio, trades, {
        requireCleanQuotes: true,
      });

      for (const r of report.rejected) {
        console.error(
          `[${portfolio.name}] REJECTED ${r.ticker}: quoted ${r.quoted} vs stored ${r.stored} (${r.movePct.toFixed(1)}% move)`,
        );
      }
      if (report.failed.length > 0) {
        console.error(`[${portfolio.name}] quote failures: ${report.failed.join(", ")}`);
      }

      if (report.snapshotLogged) {
        console.log(
          `[${portfolio.name}] snapshot logged — net liq ${report.metrics?.net_liquidity.toFixed(2)}, ${report.updated.length} tickers updated`,
        );
      } else if (report.skippedReason === "already-logged-today") {
        console.log(`[${portfolio.name}] snapshot already logged today`);
      } else {
        console.error(`[${portfolio.name}] snapshot SKIPPED — degraded quotes`);
        failures++;
      }
    } catch (e) {
      console.error(`[${portfolio.name}] refresh threw: ${(e as Error).message}`);
      failures++;
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} portfolio(s) did not produce a clean snapshot.`);
    process.exit(1);
  }
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
