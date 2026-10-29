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
import { refreshPortfolio } from "@/lib/refreshPortfolio";
import { mapTrade } from "@/lib/rows";
import type { Portfolio } from "@/types";
import { signIn } from "./env";

async function main() {
  const { client, userId, email } = await signIn();
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

    // Postgres hands numerics back as strings; the IV fallback multiplies by
    // iv_skew_ratio, so every column has to arrive as a number.
    const trades = (tRows ?? []).map(mapTrade);

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

      const { contract, atmSkew, held, failedGroups } = report.iv;
      if (contract + atmSkew + held.length > 0) {
        console.log(
          `[${portfolio.name}] IV marks — ${contract} from contract, ${atmSkew} from ATM+skew, ${held.length} held`,
        );
      }
      // Named individually: a position that holds its mark every run is a
      // contract that has stopped being quotable, and that is worth noticing
      // long before expiry rather than discovering at assignment.
      for (const h of held) {
        console.error(`[${portfolio.name}] IV held ${h.ticker}: ${h.reason}`);
      }
      if (failedGroups.length > 0) {
        console.error(
          `[${portfolio.name}] chain read failed: ${failedGroups.includes("*") ? "position-iv unavailable" : failedGroups.join(", ")}`,
        );
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
