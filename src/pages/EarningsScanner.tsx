import { useMemo, useState } from "react";
import { RefreshCw, TrendingDown, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Chart } from "@/components/charts/Chart";
import { CHART_COLORS } from "@/components/charts/theme";
import { LoadingState, EmptyState, SectionTitle } from "@/components/ui/states";
import { useEarningsScan, useRescan, type ScanCandidate } from "@/api/earnings";

const WINDOWS = [3, 7, 14];

function confColor(c: number): string {
  if (c >= 60) return CHART_COLORS.gain;
  if (c >= 40) return CHART_COLORS.amber;
  return CHART_COLORS.loss;
}
function confBadge(c: number): "gain" | "secondary" | "loss" {
  if (c >= 60) return "gain";
  if (c >= 40) return "secondary";
  return "loss";
}

export default function EarningsScanner() {
  const [days, setDays] = useState(7);
  const { data, isLoading, isError, error } = useEarningsScan(days);
  const rescan = useRescan();

  const rows = data?.results ?? [];
  const busy = isLoading || rescan.isPending;
  const tracked = useMemo(() => rows.filter((r) => r.hasHistory), [rows]);
  const noHistory = useMemo(() => rows.filter((r) => !r.hasHistory), [rows]);

  const chart = useMemo(() => {
    if (!tracked.length) return null;
    // top 20, ascending so the best sits at the top of a horizontal bar chart
    const top = [...tracked].slice(0, 20).reverse();
    return {
      y: top.map((r) => r.ticker),
      x: top.map((r) => r.confidence),
      colors: top.map((r) => confColor(r.confidence)),
      text: top.map((r) => `${r.confidence}`),
    };
  }, [tracked]);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Earnings Premium Scanner</h1>
          <p className="text-xs text-muted-foreground">
            Upcoming earnings ranked as short iron-butterfly candidates — implied vs historical
            move, premium richness, and backtested per-ticker reliability.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setDays(w)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  days === w ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => rescan.mutate(days)}
          >
            <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {data && (
        <p className="-mt-3 text-[0.7rem] text-muted-foreground">
          {data.count} candidates · generated {new Date(data.generatedAt).toLocaleString()}
          {data.cached ? " · cached" : " · live"}
        </p>
      )}

      {isLoading && <LoadingState label="Scanning upcoming earnings…" />}
      {isError && (
        <EmptyState title="Scan failed" hint={String((error as Error)?.message ?? error)} />
      )}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          title="No tradeable earnings in this window"
          hint="No upcoming earnings with listed options over the selected horizon. Try a longer window or refresh."
        />
      )}

      {chart && (
        <div>
          <SectionTitle>Tracked candidates ranked (confidence)</SectionTitle>
          <Card>
            <CardContent className="pt-5">
              <Chart
                height={Math.max(260, chart.y.length * 26)}
                data={[
                  {
                    type: "bar",
                    orientation: "h",
                    x: chart.x,
                    y: chart.y,
                    text: chart.text,
                    textposition: "auto",
                    marker: { color: chart.colors },
                    hovertemplate: "%{y}: confidence %{x}<extra></extra>",
                  },
                ]}
                layout={{
                  margin: { l: 64, r: 16, t: 8, b: 32 },
                  xaxis: { title: { text: "confidence" }, range: [0, 100] },
                  yaxis: { automargin: true },
                }}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {tracked.length > 0 && (
        <div>
          <SectionTitle>Tracked — backtested edge ({tracked.length})</SectionTitle>
          <ResultsTable rows={tracked} />
        </div>
      )}

      {noHistory.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-2">
            <SectionTitle>No history — live signals only ({noHistory.length})</SectionTitle>
          </div>
          <p className="-mt-1 mb-2 text-[0.7rem] text-muted-foreground">
            Not in the backtested universe — ranked on live signals only (richness here is the IV
            term-structure premium, not a backtested win-rate). Treat as less-vetted.
          </p>
          <ResultsTable rows={noHistory} />
        </div>
      )}

      {rows.length > 0 && (
        <p className="flex items-start gap-1.5 text-[0.7rem] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          Max gain/loss are per 1 contract (×100). Enter ~5 min before the close on the day before
          the print; exit ~15–30 min after the next open. Size each at 1–3% of equity as defined
          max-loss and spread across many names. Implied move &amp; strikes are live CBOE options
          (~15-min delayed) — confirm fills in your broker. For tracked names, richness compares the
          implied move to the expected move at that expiry; historical move &amp; win-rate are from
          the S&amp;P 500 backtest (2020–2025).
        </p>
      )}
    </div>
  );
}

function ResultsTable({ rows }: { rows: ScanCandidate[] }) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[0.7rem] uppercase tracking-wide text-muted-foreground">
              <Th>Ticker</Th>
              <Th>Earnings</Th>
              <Th right>Implied</Th>
              <Th right>Hist avg</Th>
              <Th right>Rich</Th>
              <Th right>IV</Th>
              <Th right>Hist win</Th>
              <Th>Iron butterfly (short / wings)</Th>
              <Th right>Max gain</Th>
              <Th right>Max loss</Th>
              <Th right>Conf</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.ticker} r={r} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}

function Row({ r }: { r: ScanCandidate }) {
  const bf = r.butterfly;
  const rich = r.premiumRichness;
  return (
    <tr className="border-b border-border/50 hover:bg-accent/30">
      <td className="px-3 py-2.5 font-semibold">
        {r.ticker}
        {!r.hasHistory && (
          <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[0.55rem] font-medium uppercase tracking-wide text-amber-500">
            no hist
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs">
        {r.earningsDate}
        <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[0.6rem] text-muted-foreground">
          {r.when}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{r.impliedMovePct}%</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
        {r.histMovePct != null ? `${r.histMovePct}%` : "—"}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        {rich != null ? (
          <span className={rich >= 1 ? "text-gain" : "text-loss"}>{rich.toFixed(2)}×</span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.atmIvPct}%</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
        {r.flyWinPct != null ? `${r.flyWinPct}% · n${r.sampleN}` : "—"}
      </td>
      <td className="px-3 py-2.5 text-xs">
        <span className="font-medium">{bf.shortStrike}</span>
        <span className="text-muted-foreground">
          {" "}
          ±{" "}
          <span className="text-loss/80">{bf.longPut}</span>
          {" / "}
          <span className="text-gain/80">{bf.longCall}</span>
        </span>
        <div className="text-[0.65rem] text-muted-foreground">
          {r.expiration} · {r.dte}d · cr {bf.credit} · BE {bf.beLow}–{bf.beHigh}
        </div>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-gain">${bf.maxGain}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-loss">
        <span className="inline-flex items-center gap-0.5">
          <TrendingDown className="h-3 w-3" />${bf.maxLoss}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right">
        <Badge variant={confBadge(r.confidence)}>{r.confidence}</Badge>
      </td>
    </tr>
  );
}
