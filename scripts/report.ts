/**
 * Portfolio email report: render one portfolio's daily report to files.
 *
 * Reads the portfolio's rows as the account itself (RLS, same sign-in as the
 * snapshot job), fetches SPY for the market comparison, builds the report with
 * the dashboard's own engine, and writes
 *
 *   <out>/subject.txt  <out>/report.txt
 *   <out>/report.html  — images as cid:<name>, for the email
 *   <out>/<name>.png   — those images; the sender attaches each as cid:<name>
 *   <out>/preview.html — the same page with file references, to open locally
 *
 * Delivery is deliberately not here. This repo is public; the scheduled job
 * that runs this lives in the private research repo with the credentials, and
 * sends the files with the same SMTP setup as the wheel report.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_EMAIL, SUPABASE_PASSWORD
 *      (URL and key fall back to VITE_-prefixed names), REPORT_PORTFOLIO —
 *      the portfolio's name, required, so no account's naming lives in code.
 * Args: --out DIR (default ./report-out)
 */
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  mapBookStat,
  mapCashFlow,
  mapHistoryTrade,
  mapSnapshot,
  mapTrade,
} from "@/lib/rows";
import { BENCHMARK } from "@/report/benchmark";
import { buildReport } from "@/report/portfolioReport";
import type { Portfolio } from "@/types";
import { required, signIn } from "./env";
import { fetchBenchmark, writeReport } from "./reportOutput";

function outDir(): string {
  const i = process.argv.indexOf("--out");
  return resolve(i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "report-out");
}

/** Every row of a portfolio-scoped table; fails the run rather than reporting on a partial read. */
async function rows(
  client: SupabaseClient,
  table: string,
  portfolioId: string,
  order: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from(table)
      .select("*")
      .eq("portfolio_id", portfolioId)
      // Ordered on a unique key too, so pages cannot overlap or skip.
      .order(order, { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

async function main() {
  const name = required("REPORT_PORTFOLIO");
  const { client } = await signIn();

  const { data: pRows, error: pErr } = await client.from("portfolios").select("*");
  if (pErr) throw new Error(`portfolios: ${pErr.message}`);
  const match = (pRows ?? []).filter((p) => p.name === name);
  if (match.length !== 1) {
    const have = (pRows ?? []).map((p) => JSON.stringify(p.name)).join(", ");
    console.error(`Expected one portfolio named ${JSON.stringify(name)}, found ${match.length}. Have: ${have}`);
    process.exit(2);
  }
  const portfolio = { ...match[0], cash: Number(match[0].cash) } as Portfolio;

  // research_book_stats has no `id`; its key is (user, portfolio, grain, ticker, type).
  const statsRes = await client.from("research_book_stats").select("*").eq("portfolio_id", portfolio.id);
  if (statsRes.error) throw new Error(`research_book_stats: ${statsRes.error.message}`);

  const [trades, snapshots, cashFlows, closed] = await Promise.all([
    rows(client, "trades", portfolio.id, "opened_at"),
    rows(client, "history_snapshots", portfolio.id, "ts"),
    rows(client, "cash_flows", portfolio.id, "ts"),
    rows(client, "history_trades", portfolio.id, "exit_date"),
  ]);

  const snaps = snapshots.map(mapSnapshot);
  const first = Math.min(...snaps.map((s) => new Date(s.ts).getTime()));
  const benchmark = snaps.length ? await fetchBenchmark(first) : null;

  const model = buildReport({
    portfolio,
    trades: trades.map(mapTrade),
    snapshots: snaps,
    cashFlows: cashFlows.map(mapCashFlow),
    stats: (statsRes.data ?? []).map(mapBookStat),
    closed: closed.map(mapHistoryTrade),
    benchmark,
    now: new Date(),
  });

  const dir = outDir();
  const subject = writeReport(model, dir);

  console.log(subject);
  console.log(
    `${model.trades.length} open · ${model.actions.length} actions ` +
      `(${model.actions.filter((a) => a.priority === "high").length} high) · ` +
      `${model.insights.length} track-record notes · ` +
      `${benchmark ? `${BENCHMARK} ${benchmark.length} bars` : `no ${BENCHMARK}`} -> ${dir}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
