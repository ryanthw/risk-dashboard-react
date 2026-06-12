import { useMemo } from "react";
import { format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Chart } from "@/components/charts/Chart";
import { CHART_COLORS } from "@/components/charts/theme";
import { EmptyState, LoadingState, NoPortfolio, SectionTitle } from "@/components/ui/states";
import { usePortfolioStore } from "@/store/portfolio";
import { useSnapshots, useHistoryTrades } from "@/api/history";
import { fmtUsd, fmtPct, pnlClass } from "@/lib/format";
import { TRADE_TYPE_LABELS, type TradeType } from "@/types";

export default function History() {
  const { activePortfolioId } = usePortfolioStore();
  const { data: snapshots, isLoading: loadingSnaps } = useSnapshots(activePortfolioId);
  const { data: closed, isLoading: loadingClosed } = useHistoryTrades(activePortfolioId);

  const lineData = useMemo(() => {
    if (!snapshots?.length) return null;
    return {
      x: snapshots.map((s) => s.ts),
      y: snapshots.map((s) => s.net_liquidity),
    };
  }, [snapshots]);

  if (!activePortfolioId) return <NoPortfolio />;
  if (loadingSnaps || loadingClosed) return <LoadingState />;

  const totalRealized = (closed ?? []).reduce((a, t) => a + (t.realized_pnl ?? 0), 0);
  const wins = (closed ?? []).filter((t) => (t.realized_pnl ?? 0) > 0).length;
  const winRate = closed?.length ? (wins / closed.length) * 100 : 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <SectionTitle>Net Liquidity Over Time</SectionTitle>
        <Card>
          <CardContent className="pt-5">
            {lineData ? (
              <Chart
                height={360}
                data={[
                  {
                    type: "scatter",
                    mode: "lines+markers",
                    x: lineData.x,
                    y: lineData.y,
                    line: { color: CHART_COLORS.brand, width: 2.5, shape: "spline" },
                    marker: { color: CHART_COLORS.brand, size: 6 },
                    fill: "tozeroy",
                    fillcolor: "rgba(20,153,214,0.08)",
                    hovertemplate: "%{x|%b %d}<br>$%{y:,.2f}<extra></extra>",
                  },
                ]}
                layout={{
                  yaxis: { tickprefix: "$", tickformat: ",.0f" },
                  xaxis: { type: "date" },
                  hovermode: "x unified",
                }}
              />
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
        <div className="mb-3 flex items-center justify-between">
          <SectionTitle>Closed Trade History</SectionTitle>
          {closed && closed.length > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <Badge variant={totalRealized >= 0 ? "gain" : "loss"}>
                {fmtUsd(totalRealized)} realized
              </Badge>
              <Badge variant="muted">{fmtPct(winRate, 0)} win rate</Badge>
            </div>
          )}
        </div>
        <Card>
          <CardContent className="p-0">
            {closed && closed.length > 0 ? (
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3">Ticker</th>
                      <th className="px-4 py-3">Strategy</th>
                      <th className="px-4 py-3">Exit Date</th>
                      <th className="px-4 py-3 text-right">IV @ Close</th>
                      <th className="px-4 py-3 text-right">Max Loss</th>
                      <th className="px-4 py-3 text-right">Realized P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closed.map((t) => (
                      <tr key={t.id} className="border-b border-border/50 last:border-0">
                        <td className="px-4 py-3 font-medium">{t.ticker}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {TRADE_TYPE_LABELS[t.trade_type as TradeType] ?? t.trade_type}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {t.exit_date
                            ? format(new Date(t.exit_date), "MMM d, yyyy")
                            : "—"}
                        </td>
                        <td className="px-4 py-3 text-right tnum">
                          {fmtPct((t.iv_at_close ?? 0) * 100, 1)}
                        </td>
                        <td className="px-4 py-3 text-right tnum text-muted-foreground">
                          {fmtUsd(t.max_loss)}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-semibold tnum ${pnlClass(t.realized_pnl ?? 0)}`}
                        >
                          {fmtUsd(t.realized_pnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
