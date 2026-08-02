import { useMemo, useState } from "react";
import { RefreshCw, TrendingDown, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EChart } from "@/components/charts/EChart";
import { CHART_COLORS } from "@/components/charts/theme";
import { X_NAME_GAP, categoryAxis, valueAxis } from "@/components/charts/echartsTheme";
import { EmptyState, SectionTitle, TableSkeleton } from "@/components/ui/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/useTableSort";
import { useEarningsScan, useRescan, type ScanCandidate } from "@/api/earnings";
import { useScannerFilterStore, type ScannerStructure } from "@/store/scannerFilter";
import { useActivePortfolio } from "@/hooks/useActivePortfolio";
import { fmtUsd } from "@/lib/format";

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

/** Normalized per-row view for whichever structure is selected. */
interface StructView {
  available: boolean;
  maxGain: number;
  maxLoss: number;
  credit: number;
  beLow: number;
  beHigh: number;
  confidence: number;
  winPct: number | null;
  sampleN: number;
}

/** Resolve a candidate to the selected structure. In condor mode a name with no
 *  constructible condor is marked unavailable (filtered out of the view). */
function structOf(r: ScanCandidate, structure: ScannerStructure): StructView {
  if (structure === "condor") {
    if (!r.condor) {
      return { available: false, maxGain: 0, maxLoss: 0, credit: 0, beLow: 0, beHigh: 0, confidence: 0, winPct: null, sampleN: 0 };
    }
    return {
      available: true,
      maxGain: r.condor.maxGain,
      maxLoss: r.condor.maxLoss,
      credit: r.condor.credit,
      beLow: r.condor.beLow,
      beHigh: r.condor.beHigh,
      confidence: r.condorConfidence ?? 0,
      winPct: r.condorWinPct ?? null,
      sampleN: r.condorSampleN ?? 0,
    };
  }
  const bf = r.butterfly;
  return {
    available: true,
    maxGain: bf.maxGain,
    maxLoss: bf.maxLoss,
    credit: bf.credit,
    beLow: bf.beLow,
    beHigh: bf.beHigh,
    confidence: r.confidence,
    winPct: r.flyWinPct,
    sampleN: r.sampleN,
  };
}

type Viewed = { r: ScanCandidate; v: StructView };

export default function EarningsScanner() {
  const [days, setDays] = useState(7);
  const { data, isLoading, isError, error } = useEarningsScan(days);
  const rescan = useRescan();

  const { structure, affordableOnly, maxLossPct, setStructure, setAffordableOnly, setMaxLossPct } =
    useScannerFilterStore();
  const { portValue } = useActivePortfolio();
  // Dollar max-loss budget = maxLossPct of the active portfolio value.
  const maxLossBudget = (maxLossPct / 100) * portValue;
  const filterActive = affordableOnly && maxLossBudget > 0;
  const isCondor = structure === "condor";

  const allRows = data?.results ?? [];

  // Resolve every candidate to the selected structure, drop ones the structure
  // can't be built for (condor mode), then apply the affordability filter and
  // re-rank by that structure's confidence. All client-side: switching structure
  // or toggling the filter updates instantly with no refetch, on every timeframe.
  const { base, viewed, tracked, noHistory } = useMemo(() => {
    const base: Viewed[] = allRows
      .map((r) => ({ r, v: structOf(r, structure) }))
      .filter((x) => x.v.available);
    const viewed = (filterActive ? base.filter((x) => x.v.maxLoss <= maxLossBudget) : base)
      .sort((a, b) => b.v.confidence - a.v.confidence);
    return {
      base,
      viewed,
      tracked: viewed.filter((x) => x.r.hasHistory),
      noHistory: viewed.filter((x) => !x.r.hasHistory),
    };
  }, [allRows, structure, filterActive, maxLossBudget]);

  const affordHidden = base.length - viewed.length;          // hidden by the budget filter
  const structDropped = allRows.length - base.length;        // no condor constructible
  const busy = isLoading || rescan.isPending;

  const chart = useMemo(() => {
    if (!tracked.length) return null;
    // top 20, ascending so the best sits at the top of a horizontal bar chart
    const top = [...tracked].slice(0, 20).reverse();
    return {
      y: top.map((x) => x.r.ticker),
      x: top.map((x) => x.v.confidence),
      colors: top.map((x) => confColor(x.v.confidence)),
      text: top.map((x) => `${x.v.confidence}`),
    };
  }, [tracked]);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {/* Title lives in the TopBar — this is the descriptive line only. */}
          <p className="max-w-2xl text-xs text-muted-foreground">
            Upcoming earnings ranked as short {isCondor ? "iron-condor" : "iron-butterfly"}{" "}
            candidates — implied vs historical move, premium richness, and backtested per-ticker
            reliability.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={structure} onValueChange={(v) => setStructure(v as ScannerStructure)}>
            <SelectTrigger className="h-8 w-[9.5rem] text-xs" aria-label="Option structure">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="butterfly">Iron butterfly</SelectItem>
              <SelectItem value="condor">Iron condor</SelectItem>
            </SelectContent>
          </Select>
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

      {/* affordability filter — hide trades whose max loss exceeds a % of the account */}
      <div className="-mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <label className="flex cursor-pointer items-center gap-1.5 select-none">
          <input
            type="checkbox"
            checked={affordableOnly}
            onChange={(e) => setAffordableOnly(e.target.checked)}
            className="rd-checkbox"
          />
          <span className="text-muted-foreground">Hide trades with max loss over</span>
        </label>
        <div className="flex items-center gap-1">
          <NumberInput
            value={maxLossPct}
            onChange={(n) => setMaxLossPct(Math.max(0, n))}
            zeroAsEmpty={false}
            min={0}
            className="h-6 w-14 px-1.5 py-0 text-right text-xs"
            aria-label="Max loss percent of account"
          />
          <span className="text-muted-foreground">% of account</span>
        </div>
        {affordableOnly &&
          (portValue > 0 ? (
            <span className="text-muted-foreground/80">
              (≤ {fmtUsd(maxLossBudget, true)} of {fmtUsd(portValue, true)}
              {affordHidden > 0 ? ` · ${affordHidden} hidden` : ""})
            </span>
          ) : (
            <span className="text-amber-500/90">
              Set the active portfolio's cash to use this filter
            </span>
          ))}
      </div>

      {data && (
        <p className="text-[0.7rem] text-muted-foreground">
          {filterActive ? `${viewed.length} of ${data.count}` : viewed.length} candidates · generated{" "}
          {new Date(data.generatedAt).toLocaleString()}
          {data.cached ? " · cached" : " · live"}
          {isCondor && structDropped > 0 ? ` · ${structDropped} without a condor chain` : ""}
        </p>
      )}

      {isLoading && <TableSkeleton rows={8} />}
      {isError && (
        <EmptyState title="Scan failed" hint={String((error as Error)?.message ?? error)} />
      )}
      {!isLoading && !isError && viewed.length === 0 && (
        filterActive && base.length > 0 ? (
          <EmptyState
            title="All candidates filtered out"
            hint={`Every candidate's max loss exceeds ${maxLossPct}% of your account (${fmtUsd(maxLossBudget, true)}). Raise the percent or uncheck the filter.`}
          />
        ) : (
          <EmptyState
            title="No tradeable earnings in this window"
            hint="No upcoming earnings with listed options over the selected horizon. Try a longer window or refresh."
          />
        )
      )}

      {chart && (
        <div>
          <SectionTitle>Tracked candidates ranked (confidence)</SectionTitle>
          <Card>
            <CardContent className="pt-5">
              <EChart
                height={Math.max(260, chart.y.length * 26)}
                option={{
                  grid: { left: 12, right: 24, top: 10, bottom: 40, containLabel: true },
                  xAxis: { ...valueAxis("confidence"), min: 0, max: 100, nameGap: X_NAME_GAP },
                  // `chart` is already built ascending so the best candidate
                  // lands at the top; ECharts renders category 0 at the bottom,
                  // same as Plotly did, so no further reordering here.
                  yAxis: { ...categoryAxis(), data: chart.y },
                  tooltip: {
                    trigger: "item",
                    formatter: (p: unknown) => {
                      const d = p as { name: string; value: number };
                      return `${d.name}: confidence ${d.value}`;
                    },
                  },
                  series: [
                    {
                      type: "bar",
                      data: chart.x.map((v, i) => ({
                        value: v,
                        itemStyle: {
                          color: chart.colors[i],
                          borderRadius: [0, 3, 3, 0],
                        },
                      })),
                      barCategoryGap: "30%",
                      label: {
                        show: true,
                        position: "insideRight",
                        color: CHART_COLORS.text,
                        fontSize: 10,
                      },
                    },
                  ],
                }}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {tracked.length > 0 && (
        <div>
          <SectionTitle>Tracked — backtested edge ({tracked.length})</SectionTitle>
          <ResultsTable rows={tracked} structure={structure} />
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
          <ResultsTable rows={noHistory} structure={structure} />
        </div>
      )}

      {viewed.length > 0 && (
        <p className="flex items-start gap-1.5 text-[0.7rem] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          Max gain/loss are per 1 contract (×100). Enter ~5 min before the close on the day before
          the print; exit ~15–30 min after the next open. Size each at 1–3% of equity as defined
          max-loss and spread across many names. Implied move &amp; strikes are live CBOE options
          (~15-min delayed) — confirm fills in your broker. For tracked names, richness compares the
          implied move to the expected move at that expiry; historical move &amp; win-rate are from
          the backtest (2020–2025). {isCondor
            ? "Iron condor: sell the Δ16 strangle body, buy Δ5 wings — wider profit zone, smaller credit."
            : "Iron butterfly: sell the ATM straddle body, buy Δ10 wings — richest credit, tighter zone."}
        </p>
      )}
    </div>
  );
}

function ResultsTable({ rows, structure }: { rows: Viewed[]; structure: ScannerStructure }) {
  const { sorted, sortKey, dir, onSort } = useTableSort(rows, {
    // Matches the incoming rank, so the default view is unchanged until the
    // user clicks a header.
    initialKey: "conf",
    initialDir: "desc",
    accessors: {
      ticker: ({ r }) => r.ticker,
      earnings: ({ r }) => r.earningsDate,
      implied: ({ r }) => r.impliedMovePct,
      hist: ({ r }) => r.histMovePct,
      rich: ({ r }) => r.premiumRichness,
      iv: ({ r }) => r.atmIvPct,
      win: ({ v }) => v.winPct,
      maxGain: ({ v }) => v.maxGain,
      maxLoss: ({ v }) => v.maxLoss,
      conf: ({ v }) => v.confidence,
    },
  });
  const sortProps = { activeKey: sortKey, dir, onSort };

  return (
    <Card>
      <CardContent className="p-0">
        <TableWrap maxHeight={620}>
          <Table>
            <TableHeader>
              <tr>
                <TableHead sortKey="ticker" {...sortProps}>
                  Ticker
                </TableHead>
                <TableHead sortKey="earnings" {...sortProps}>
                  Earnings
                </TableHead>
                <TableHead right sortKey="implied" {...sortProps}>
                  Implied
                </TableHead>
                <TableHead right sortKey="hist" {...sortProps}>
                  Hist avg
                </TableHead>
                <TableHead right sortKey="rich" {...sortProps}>
                  Rich
                </TableHead>
                <TableHead right sortKey="iv" {...sortProps}>
                  IV
                </TableHead>
                <TableHead right sortKey="win" {...sortProps}>
                  Hist win
                </TableHead>
                <TableHead>
                  {structure === "condor"
                    ? "Iron condor (wings / shorts)"
                    : "Iron butterfly (short / wings)"}
                </TableHead>
                <TableHead right sortKey="maxGain" {...sortProps}>
                  Max gain
                </TableHead>
                <TableHead right sortKey="maxLoss" {...sortProps}>
                  Max loss
                </TableHead>
                <TableHead right sortKey="conf" {...sortProps}>
                  Conf
                </TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {sorted.map(({ r, v }) => (
                <Row key={r.ticker} r={r} v={v} structure={structure} />
              ))}
            </TableBody>
          </Table>
        </TableWrap>
      </CardContent>
    </Card>
  );
}

function StrikeCell({ r, structure }: { r: ScanCandidate; structure: ScannerStructure }) {
  if (structure === "condor" && r.condor) {
    const c = r.condor;
    return (
      <>
        <span className="text-loss/80">{c.longPut}</span>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium">{c.shortPut}</span>
        <span className="text-muted-foreground"> – </span>
        <span className="font-medium">{c.shortCall}</span>
        <span className="text-muted-foreground">/</span>
        <span className="text-gain/80">{c.longCall}</span>
        <div className="text-[0.65rem] text-muted-foreground">
          {r.expiration} · {r.dte}d · cr {c.credit} · BE {c.beLow}–{c.beHigh}
        </div>
      </>
    );
  }
  const bf = r.butterfly;
  return (
    <>
      <span className="font-medium">{bf.shortStrike}</span>
      <span className="text-muted-foreground">
        {" "}
        ± <span className="text-loss/80">{bf.longPut}</span>
        {" / "}
        <span className="text-gain/80">{bf.longCall}</span>
      </span>
      <div className="text-[0.65rem] text-muted-foreground">
        {r.expiration} · {r.dte}d · cr {bf.credit} · BE {bf.beLow}–{bf.beHigh}
      </div>
    </>
  );
}

function Row({ r, v, structure }: { r: ScanCandidate; v: StructView; structure: ScannerStructure }) {
  const rich = r.premiumRichness;
  return (
    <TableRow>
      <TableCell className="font-semibold">
        {r.ticker}
        {!r.hasHistory && (
          <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[0.55rem] font-medium uppercase tracking-wide text-amber-500">
            no hist
          </span>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {r.earningsDate}
        <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[0.6rem] text-muted-foreground">
          {r.when}
        </span>
      </TableCell>
      <TableCell right>{r.impliedMovePct}%</TableCell>
      <TableCell right className="text-muted-foreground">
        {r.histMovePct != null ? `${r.histMovePct}%` : "—"}
      </TableCell>
      <TableCell right>
        {rich != null ? (
          <span className={rich >= 1 ? "text-gain" : "text-loss"}>{rich.toFixed(2)}×</span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell right className="text-muted-foreground">
        {r.atmIvPct}%
      </TableCell>
      <TableCell right className="text-muted-foreground">
        {v.winPct != null ? `${v.winPct}% · n${v.sampleN}` : "—"}
      </TableCell>
      <TableCell className="text-xs">
        <StrikeCell r={r} structure={structure} />
      </TableCell>
      <TableCell right className="text-gain">
        ${v.maxGain}
      </TableCell>
      <TableCell right className="text-loss">
        <span className="inline-flex items-center gap-0.5">
          <TrendingDown className="h-3 w-3" />${v.maxLoss}
        </span>
      </TableCell>
      <TableCell right>
        <Badge variant={confBadge(v.confidence)}>{v.confidence}</Badge>
      </TableCell>
    </TableRow>
  );
}
