import { useMemo } from "react";
import { format } from "date-fns";
import { AlertTriangle, CircleHelp, Minus, TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  EmptyState,
  NoPortfolio,
  SectionTitle,
  TableSkeleton,
} from "@/components/ui/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "@/components/ui/table";
import { usePortfolioStore } from "@/store/portfolio";
import { useTrades } from "@/api/trades";
import { useBookStats } from "@/api/bookStats";
import {
  buildInsights,
  rateOrNull,
  MIN_N_FOR_RATE,
  type Insight,
  type InsightTone,
} from "@/engine/insights";
import { fmtUsd, fmtPct, pnlClass } from "@/lib/format";
import { TRADE_TYPE_LABELS, type BookStat, type Trade, type TradeType } from "@/types";

const TONE_ICON: Record<InsightTone, typeof TrendingUp> = {
  positive: TrendingUp,
  negative: AlertTriangle,
  neutral: Minus,
  unknown: CircleHelp,
};

const TONE_CLASS: Record<InsightTone, string> = {
  positive: "text-emerald-400",
  negative: "text-red-400",
  neutral: "text-muted-foreground",
  unknown: "text-amber-400",
};

/** A rate, or an em dash when too few trades stand behind it to quote one. */
function Rate({ value, n }: { value: number | null; n: number }) {
  const shown = rateOrNull(value, n);
  if (shown == null) {
    return (
      <span className="text-muted-foreground" title={`${n} closed — too few to quote a rate`}>
        —
      </span>
    );
  }
  // A shown rate still says what it rests on — 80% over 5 trades and 80% over
  // 50 are different claims and the cell cannot show that on its own.
  return <span title={`${n} closed trades`}>{fmtPct(shown * 100, 0)}</span>;
}

function InsightCard({ insight }: { insight: Insight }) {
  const Icon = TONE_ICON[insight.tone];
  return (
    <Card>
      <CardContent className="flex gap-3 p-4">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TONE_CLASS[insight.tone]}`} />
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-semibold leading-snug">{insight.title}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{insight.body}</p>
          {/* The sample is part of the claim, never a footnote to it. */}
          <p className="font-mono text-[0.7rem] text-muted-foreground/80">{insight.basis}</p>
          {insight.subjects.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {insight.subjects.slice(0, 8).map((s, i) => (
                <Badge key={`${s}-${i}`} variant="secondary" className="font-mono text-[0.7rem]">
                  {s}
                </Badge>
              ))}
              {insight.subjects.length > 8 && (
                <Badge variant="secondary" className="text-[0.7rem]">
                  +{insight.subjects.length - 8}
                </Badge>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function PortfolioInsights() {
  const { activePortfolioId } = usePortfolioStore();
  const { data: stats, isLoading } = useBookStats(activePortfolioId);
  const { data: trades } = useTrades(activePortfolioId);

  const open = useMemo(() => trades ?? [], [trades]);
  const rows = useMemo(() => stats ?? [], [stats]);
  const portfolio = rows.find((s) => s.grain === "portfolio");
  const insights = useMemo(() => buildInsights(rows, open), [rows, open]);

  // Open exposure keyed the same way the research is, so the two can be shown
  // side by side: the whole point of the page is the comparison.
  const openByType = useMemo(() => countBy(open, (t) => t.trade_type), [open]);
  const openByTicker = useMemo(() => countBy(open, (t) => t.ticker), [open]);

  const structures = useMemo(
    () => mergeRows(rows, "strategy", (s) => s.trade_type, openByType),
    [rows, openByType],
  );
  const tickers = useMemo(
    () => mergeRows(rows, "ticker", (s) => s.ticker, openByTicker),
    [rows, openByTicker],
  );

  if (!activePortfolioId) return <NoPortfolio />;
  if (isLoading) return <TableSkeleton rows={8} />;

  if (!portfolio) {
    return (
      <div className="space-y-5">
        <Card>
          <CardContent className="p-5">
            <EmptyState
              title="No research for this portfolio yet"
              hint="Insights are derived from closed trades on the research side and loaded separately. They appear once this portfolio has a closed-trade history."
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          {portfolio.n_pnl} closed · {fmtPct((portfolio.win_rate ?? 0) * 100, 0)} win ·{" "}
          <span className={pnlClass(portfolio.total_pnl ?? 0)}>
            {fmtUsd(portfolio.total_pnl)}
          </span>{" "}
          realized
          {portfolio.first_exit && (
            <> · since {format(new Date(portfolio.first_exit), "MMM d, yyyy")}</>
          )}
        </p>
        {/* Derived on a schedule, not live — say so rather than implying freshness. */}
        <p className="mt-0.5 text-[0.7rem] text-muted-foreground/70">
          Research as of {portfolio.as_of}. Open positions are live.
        </p>
      </div>

      {insights.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">
          {insights.map((i) => (
            <InsightCard key={i.id} insight={i} />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-5">
            <EmptyState
              title="Nothing worth calling out yet"
              hint={`Every structure here has fewer than the ${MIN_N_FOR_RATE} closed trades needed to say anything that would not just be noise. The tables below show what there is.`}
            />
          </CardContent>
        </Card>
      )}

      <ExposureTable
        title="By structure"
        keyLabel="Structure"
        rows={structures}
        render={(k) => TRADE_TYPE_LABELS[k as TradeType] ?? k}
      />
      <ExposureTable
        title="By ticker"
        keyLabel="Ticker"
        rows={tickers}
        render={(k) => k}
        mono
      />
    </div>
  );
}

interface MergedRow {
  key: string;
  open: number;
  stat: BookStat | null;
}

function countBy(list: Trade[], pick: (t: Trade) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of list) m.set(pick(t), (m.get(pick(t)) ?? 0) + 1);
  return m;
}

/**
 * Union of what research knows and what is currently held. Both directions
 * matter: exposure with no history is the page's most important signal, and a
 * structure with history and no exposure is how you notice you stopped.
 */
function mergeRows(
  stats: BookStat[],
  grain: BookStat["grain"],
  pick: (s: BookStat) => string,
  openCounts: Map<string, number>,
): MergedRow[] {
  const byKey = new Map<string, BookStat>();
  for (const s of stats) if (s.grain === grain) byKey.set(pick(s), s);
  const keys = new Set([...byKey.keys(), ...openCounts.keys()]);
  return [...keys]
    .map((key) => ({ key, open: openCounts.get(key) ?? 0, stat: byKey.get(key) ?? null }))
    .sort((a, b) => {
      // Held first, then by realized P&L: what you own outranks what you owned.
      if ((b.open > 0 ? 1 : 0) !== (a.open > 0 ? 1 : 0)) return b.open > 0 ? 1 : -1;
      return (b.stat?.total_pnl ?? 0) - (a.stat?.total_pnl ?? 0);
    });
}

function ExposureTable({
  title,
  keyLabel,
  rows,
  render,
  mono,
}: {
  title: string;
  keyLabel: string;
  rows: MergedRow[];
  render: (k: string) => string;
  mono?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <SectionTitle>{title}</SectionTitle>
      <Card className="mt-2">
        <CardContent className="p-0">
          <TableWrap maxHeight={420}>
            <Table>
              <TableHeader>
                <tr>
                  <TableHead>{keyLabel}</TableHead>
                  <TableHead right>Open</TableHead>
                  <TableHead right>Closed</TableHead>
                  <TableHead right>Win</TableHead>
                  <TableHead right>Realized</TableHead>
                  <TableHead right>Mean RoR</TableHead>
                  <TableHead right>Hold</TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {rows.map(({ key, open, stat }) => (
                  <TableRow key={key}>
                    <TableCell className={mono ? "font-mono font-medium" : "font-medium"}>
                      {render(key)}
                    </TableCell>
                    <TableCell right className={open ? "" : "text-muted-foreground"}>
                      {open || "—"}
                    </TableCell>
                    <TableCell right className="text-muted-foreground">
                      {stat?.n_pnl ?? "—"}
                    </TableCell>
                    <TableCell right>
                      {stat ? <Rate value={stat.win_rate} n={stat.n_pnl} /> : "—"}
                    </TableCell>
                    <TableCell right className={stat ? pnlClass(stat.total_pnl ?? 0) : ""}>
                      {stat ? fmtUsd(stat.total_pnl) : "—"}
                    </TableCell>
                    <TableCell right className="text-muted-foreground">
                      {/* Same rule as the win rate: a mean over one or two
                          trades is not a mean worth printing. */}
                      {stat && stat.mean_ror != null && stat.n_ror >= MIN_N_FOR_RATE ? (
                        <span
                          title={`mean over the ${stat.n_ror} of ${stat.n_pnl} trades with a capital-at-risk denominator`}
                        >
                          {fmtPct(stat.mean_ror * 100, 1)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell right className="text-muted-foreground">
                      {stat?.median_hold_days != null ? `${stat.median_hold_days}d` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>
    </div>
  );
}
