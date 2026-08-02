import { useMemo } from "react";
import { format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import { CHART_COLORS, CHART_SURFACE, mixHex } from "@/components/charts/theme";
import {
  axisGrid,
  axisUsd,
  categoryAxis,
  tipUsd,
  valueAxis,
} from "@/components/charts/echartsTheme";
import {
  EmptyState,
  NoPortfolio,
  SectionTitle,
  Skeleton,
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
import { useTableSort } from "@/hooks/useTableSort";
import { usePortfolioStore } from "@/store/portfolio";
import { useSnapshots, useHistoryTrades } from "@/api/history";
import { fmtUsd, fmtPct, pnlClass } from "@/lib/format";
import { TRADE_TYPE_LABELS, type TradeType } from "@/types";

export default function History() {
  const { activePortfolioId } = usePortfolioStore();
  const { data: snapshots, isLoading: loadingSnaps } = useSnapshots(activePortfolioId);
  const { data: closed, isLoading: loadingClosed } = useHistoryTrades(activePortfolioId);

  const netLiqOption = useMemo<EChartsOption | null>(() => {
    if (!snapshots?.length) return null;
    return {
      grid: { ...axisGrid(), left: 8, bottom: 32 },
      xAxis: { ...categoryAxis(), type: "time" as const, name: undefined },
      yAxis: valueAxis(undefined, axisUsd),
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        valueFormatter: (v: unknown) => tipUsd(Number(v)),
      },
      series: [
        {
          type: "line",
          name: "Net Liquidity",
          // Straight segments: these are discrete daily snapshots, and a spline
          // invents intermediate values that were never observed.
          smooth: false,
          symbolSize: 6,
          data: snapshots.map((s) => [s.ts, s.net_liquidity] as [string, number]),
          lineStyle: { color: CHART_COLORS.brand, width: 2.5 },
          itemStyle: { color: CHART_COLORS.brand },
          areaStyle: { color: mixHex(CHART_COLORS.brand, CHART_SURFACE, 0.78), opacity: 0.6 },
        },
      ],
    };
  }, [snapshots]);

  // Stable identity so the sort memo doesn't re-run on every render.
  const closedRows = useMemo(() => closed ?? [], [closed]);
  const { sorted, sortKey, dir, onSort } = useTableSort(closedRows, {
    initialKey: "exit",
    initialDir: "desc",
    accessors: {
      ticker: (t) => t.ticker,
      strategy: (t) => TRADE_TYPE_LABELS[t.trade_type as TradeType] ?? t.trade_type,
      exit: (t) => (t.exit_date ? new Date(t.exit_date).getTime() : null),
      iv: (t) => t.iv_at_close ?? null,
      maxLoss: (t) => t.max_loss ?? null,
      pnl: (t) => t.realized_pnl ?? null,
    },
  });
  const sortProps = { activeKey: sortKey, dir, onSort };

  if (!activePortfolioId) return <NoPortfolio />;
  if (loadingSnaps || loadingClosed)
    return (
      <div className="mx-auto max-w-7xl space-y-6">
        <Skeleton className="h-[26rem]" />
        <TableSkeleton />
      </div>
    );

  const totalRealized = (closed ?? []).reduce((a, t) => a + (t.realized_pnl ?? 0), 0);
  const wins = (closed ?? []).filter((t) => (t.realized_pnl ?? 0) > 0).length;
  const winRate = closed?.length ? (wins / closed.length) * 100 : 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <SectionTitle>Net Liquidity Over Time</SectionTitle>
        <Card>
          <CardContent className="pt-5">
            {netLiqOption ? (
              <EChart height={360} option={netLiqOption} />
            ) : (
              <EmptyState
                title="No snapshots yet"
                hint="Use Refresh on the top bar to log a daily portfolio snapshot."
              />
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        <SectionTitle
          action={
            closed && closed.length > 0 ? (
              <div className="flex items-center gap-2 text-sm">
                <Badge variant={totalRealized >= 0 ? "gain" : "loss"}>
                  {fmtUsd(totalRealized)} realized
                </Badge>
                <Badge variant="muted">{fmtPct(winRate, 0)} win rate</Badge>
              </div>
            ) : null
          }
        >
          Closed Trade History
        </SectionTitle>
        <Card>
          <CardContent className="p-0">
            {closed && closed.length > 0 ? (
              <TableWrap maxHeight={520}>
                <Table>
                  <TableHeader>
                    <tr>
                      <TableHead sortKey="ticker" {...sortProps}>
                        Ticker
                      </TableHead>
                      <TableHead sortKey="strategy" {...sortProps}>
                        Strategy
                      </TableHead>
                      <TableHead sortKey="exit" {...sortProps}>
                        Exit Date
                      </TableHead>
                      <TableHead right sortKey="iv" {...sortProps}>
                        IV @ Close
                      </TableHead>
                      <TableHead right sortKey="maxLoss" {...sortProps}>
                        Max Loss
                      </TableHead>
                      <TableHead right sortKey="pnl" {...sortProps}>
                        Realized P&L
                      </TableHead>
                    </tr>
                  </TableHeader>
                  <TableBody>
                    {sorted.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="font-medium">{t.ticker}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {TRADE_TYPE_LABELS[t.trade_type as TradeType] ?? t.trade_type}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {t.exit_date
                            ? format(new Date(t.exit_date), "MMM d, yyyy")
                            : "—"}
                        </TableCell>
                        <TableCell right>
                          {fmtPct((t.iv_at_close ?? 0) * 100, 1)}
                        </TableCell>
                        <TableCell right className="text-muted-foreground">
                          {fmtUsd(t.max_loss)}
                        </TableCell>
                        <TableCell
                          right
                          className={`font-semibold ${pnlClass(t.realized_pnl ?? 0)}`}
                        >
                          {fmtUsd(t.realized_pnl)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableWrap>
            ) : (
              <div className="p-5">
                <EmptyState
                  title="No closed trades"
                  hint="Closed positions you archive will appear here with realized P&L."
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
