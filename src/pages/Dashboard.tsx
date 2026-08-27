import { useMemo, useState } from "react";
import type { Format } from "@number-flow/react";
import { AlertTriangle, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Metric, StatRow } from "@/components/ui/metric";
import {
  DashboardSkeleton,
  EmptyState,
  NoPortfolio,
  SectionTitle,
} from "@/components/ui/states";
import { EquityCurve } from "@/components/charts/EquityCurve";
import { TradeCard } from "@/components/trades/TradeCard";
import { AddTradeDialog } from "@/components/trades/AddTradeDialog";
import { useActivePortfolio } from "@/hooks/useActivePortfolio";
import { useSnapshots, useHistoryTrades } from "@/api/history";
import { useCashFlows } from "@/api/cashFlows";
import { fmtUsd, fmtNum, fmtPct, fmtMultiple } from "@/lib/format";
import * as P from "@/engine/portfolio";
import * as R from "@/engine/portfolioRisk";
import { trackRecord } from "@/engine/trackRecord";
import { curveStats, selfPercentile } from "@/engine/equityCurve";
import { computeTwr, riskAdjusted } from "@/engine/twr";
import { RISK_FREE_RATE } from "@/engine/blackScholes";

// Kept in sync with fmtUsd in lib/format so the animated readout and the
// static fallback render identically.
const USD_FMT: Format = {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
};
/** Positions expiring inside this window are surfaced as needing attention. */
const EXPIRY_WARN_DAYS = 7;

export default function Dashboard() {
  const { portfolioId, positions, cash, portValue, isLoading } = useActivePortfolio();
  const { data: snapshots } = useSnapshots(portfolioId);
  const { data: closedTrades } = useHistoryTrades(portfolioId);
  // isSuccess, not just data: if the ledger query fails the fallback would be
  // an empty flow list, which silently turns TWR back into the naive balance
  // return while still labelling it TWR.
  const { data: cashFlows, isSuccess: ledgerReady } = useCashFlows(portfolioId);
  const [tickerFilter, setTickerFilter] = useState<string | null>(null);

  const stats = useMemo(() => {
    if (positions.length === 0) return null;
    const netLiq = P.netLiquidity(positions, cash);
    return {
      gross: P.grossExposure(positions),
      netLiq,
      hhi: P.hhi(positions),
      pctExposure: P.percentExposure(positions, cash),
      leverage: P.leverageRatio(positions, cash),
      cashToPos: P.cashToPosRatio(positions, cash),
      highestPos: P.highestPosPercent(positions, cash),
      expReturns: P.expectedReturns(positions),
      maxProfit: P.maxProfit(positions),
      riskReward: P.riskRewardRatio(positions),
      cashPct: P.cashPercent(positions, cash),
      undeployed: P.undeployedCash(positions, cash),
      betaDelta: P.betaWeightedDelta(positions),
      erAnn: P.erAnn(positions, cash) * 100,
      erPct: P.erPercent(positions, cash),
      greeks: R.portfolioGreeks(positions),
      tail: R.expiryTailRisk(positions),
      assignments: R.assignmentRisks(positions),
      expiring: R.expiringWithin(positions, EXPIRY_WARN_DAYS),
      nearestDte: R.nearestDte(positions),
      largest: R.largestTickerRisk(positions, portValue),
      undefinedRisk: R.undefinedRiskCount(positions),
    };
  }, [positions, cash, portValue]);

  const curve = useMemo(() => curveStats(snapshots ?? []), [snapshots]);
  const twr = useMemo(
    () => (ledgerReady ? computeTwr(snapshots ?? [], cashFlows ?? []) : null),
    [snapshots, cashFlows, ledgerReady],
  );
  const risk = useMemo(
    () => (twr ? riskAdjusted(twr, RISK_FREE_RATE) : null),
    [twr],
  );
  const erpaRank = useMemo(() => selfPercentile(snapshots ?? [], "erpa"), [snapshots]);
  const record = useMemo(() => trackRecord(closedTrades ?? []), [closedTrades]);

  const tickers = useMemo(
    () => [...new Set(positions.map((p) => p.trade.ticker))].sort(),
    [positions],
  );
  const visiblePositions = useMemo(
    () => (tickerFilter ? positions.filter((p) => p.trade.ticker === tickerFilter) : positions),
    [positions, tickerFilter],
  );

  if (!portfolioId) return <NoPortfolio />;
  if (isLoading) return <DashboardSkeleton />;

  // theta is a credit for short premium, so a positive value is the good case.
  const theta = stats?.greeks.theta ?? 0;
  const attention = (stats?.assignments.length ?? 0) + (stats?.expiring.length ?? 0);
  // Whether anything in that group is a problem rather than a good outcome.
  const adverse =
    (stats?.assignments.some((a) => !a.atMaxProfit) ?? false) ||
    (stats?.expiring.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* Headline row — the numbers needed to operate, unchanged in spirit. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Metric
          label="Total Value"
          value={fmtUsd(portValue)}
          animate={portValue}
          format={USD_FMT}
          accent="primary"
          delta={
            curve?.changeVsPrior != null
              ? `${curve.changeVsPrior >= 0 ? "+" : ""}${fmtUsd(curve.changeVsPrior)}`
              : undefined
          }
          deltaPositive={(curve?.changeVsPrior ?? 0) >= 0}
          hint={curve?.changeVsPrior != null ? "vs last snapshot" : undefined}
        />
        <Metric
          label="Gross Exposure"
          value={fmtUsd(stats?.gross ?? 0)}
          animate={stats?.gross ?? 0}
          format={USD_FMT}
          hint={stats?.undefinedRisk ? `${stats.undefinedRisk} undefined-risk` : undefined}
        />
        <Metric
          label="Net Liquidity"
          value={fmtUsd(stats?.netLiq ?? 0)}
          animate={stats?.netLiq ?? 0}
          format={USD_FMT}
        />
        <Metric
          label="Buying Power"
          value={fmtUsd(stats?.undeployed ?? cash)}
          animate={stats?.undeployed ?? cash}
          format={USD_FMT}
          hint={
            stats?.undefinedRisk
              ? "excl. naked short calls"
              : stats
                ? `of ${fmtUsd(cash)} cash`
                : undefined
          }
        />
        <Metric
          label="Open Trades"
          value={positions.length}
          animate={positions.length}
          hint={stats?.nearestDte != null ? `${Math.floor(stats.nearestDte)}d to nearest` : undefined}
        />
      </div>

      {/* Equity curve, full width. */}
      <div>
        <SectionTitle
          action={
            curve ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {twr ? (
                  <>
                    <Badge variant={twr.totalReturn >= 0 ? "gain" : "loss"}>
                      {twr.totalReturn >= 0 ? "+" : ""}
                      {fmtPct(twr.totalReturn * 100, 2)} TWR
                    </Badge>
                    <Badge variant={twr.tradingPnl >= 0 ? "gain" : "loss"}>
                      {twr.tradingPnl >= 0 ? "+" : ""}
                      {fmtUsd(twr.tradingPnl)} trading
                    </Badge>
                    <Badge variant="muted">
                      {fmtPct(twr.currentDrawdown, 1)} off high
                    </Badge>
                  </>
                ) : (
                  <Badge variant={curve.changeVsFirst >= 0 ? "gain" : "loss"}>
                    {curve.changeVsFirst >= 0 ? "+" : ""}
                    {fmtUsd(curve.changeVsFirst)} balance change
                  </Badge>
                )}
                <Badge variant="muted">{curve.count} snapshots</Badge>
              </div>
            ) : null
          }
        >
          Net Liquidity
        </SectionTitle>
        <Card>
          <CardContent className="pt-5">
            {snapshots && snapshots.length > 0 ? (
              <>
                <EquityCurve
                  snapshots={snapshots}
                  height={340}
                  highWaterMark={curve?.highWaterMark ?? null}
                />
                {/* The line is still a balance; TWR is what strips the deposits
                    out of it. Keep the distinction explicit on the page. */}
                <p className="mt-3 text-xs text-muted-foreground">
                  Line shows balance
                  {twr && twr.netContributions !== 0
                    ? `, including ${fmtUsd(twr.netContributions)} net contributions`
                    : ""}
                  ; TWR above removes contributions.
                  {twr?.annualized != null
                    ? ` ${fmtPct(twr.annualized * 100, 1)} annualized over ${twr.spanDays}d.`
                    : twr
                      ? ` Too short a span (${twr.spanDays}d) to annualize.`
                      : ""}
                  {curve?.medianGapDays != null
                    ? ` Sampled on refresh, median ${fmtNum(curve.medianGapDays, 1)}d apart.`
                    : ""}
                </p>
              </>
            ) : (
              <EmptyState
                title="No snapshots yet"
                hint="Use Refresh on the top bar to log a daily portfolio snapshot."
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Needs attention — only rendered when there is something to act on. */}
      {attention > 0 && stats && (
        <div>
          <SectionTitle>Needs Attention</SectionTitle>
          {/* Red border only when something here is actually going wrong: a
              debit spread whose short leg is ITM is at max profit. */}
          <Card className={adverse ? "border-loss/30" : undefined}>
            <CardContent className="space-y-2 pt-5">
              {stats.assignments.map((a) => (
                <StatRow
                  key={`itm-${a.position.trade.id}`}
                  tone={a.atMaxProfit ? "gain" : "loss"}
                  label={
                    a.atMaxProfit
                      ? `${a.position.trade.ticker} at max profit — short ${a.kind} ${fmtUsd(a.strike)} ITM; watch for early assignment`
                      : `${a.position.trade.ticker} short ${a.kind} ${fmtUsd(a.strike)} is ITM`
                  }
                  value={`${fmtPct(a.itmPct, 1)} in`}
                />
              ))}
              {stats.expiring.map((p) => (
                <StatRow
                  key={`exp-${p.trade.id}`}
                  tone="muted"
                  label={`${p.trade.ticker} expires in ${Math.floor(p.metrics.dte)}d`}
                  value={fmtUsd(p.metrics.value)}
                />
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Stat tiles. Four columns, grouped so no card carries the bulk: the
          risk-adjusted ratios used to land in the same card as exposure and
          tail risk, which left it at eleven rows against six. */}
      {stats ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Card>
            <CardContent className="space-y-2 pt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Greeks & Income
              </p>
              <StatRow
                label="Theta / day"
                value={fmtUsd(theta)}
                tone={theta >= 0 ? "gain" : "loss"}
              />
              <StatRow
                label="Theta % net liq"
                value={fmtPct(stats.netLiq > 0 ? (theta / stats.netLiq) * 100 : 0, 2)}
              />
              <StatRow label="Vega / vol pt" value={fmtUsd(stats.greeks.vega)} />
              <StatRow label="Beta-wtd Delta" value={fmtNum(stats.betaDelta, 0)} />
              <StatRow label="Expected Returns" value={fmtUsd(stats.expReturns)} />
              <StatRow label="ERPA (ann.)" value={fmtPct(stats.erAnn)} />
              {erpaRank && (
                <StatRow
                  label="ERPA percentile"
                  tone="muted"
                  value={`${fmtPct(erpaRank.percentile, 0)} · n=${erpaRank.n}`}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-2 pt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Exposure
              </p>
              <StatRow label="Percent Exposure" value={fmtPct(stats.pctExposure)} />
              <StatRow
                label="HHI"
                value={`${fmtNum(stats.hhi)}${stats.largest ? ` · ${stats.largest.ticker}` : ""}`}
              />
              <StatRow label="Leverage Ratio" value={fmtMultiple(stats.leverage)} />
              <StatRow label="Highest Position" value={fmtPct(stats.highestPos)} />
              <StatRow label="Collateral Held" value={fmtUsd(cash - stats.undeployed)} />
              <StatRow label="Cash Percent" value={fmtPct(stats.cashPct)} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-2 pt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Tail & Risk-Adjusted
              </p>
              {stats.tail ? (
                <>
                  <StatRow label="VaR 95%" tone="loss" value={fmtUsd(stats.tail.var95)} />
                  <StatRow label="CVaR 95%" tone="loss" value={fmtUsd(stats.tail.cvar95)} />
                </>
              ) : (
                <StatRow label="VaR 95%" tone="muted" value="No option legs" />
              )}
              {/* Omitted entirely below MIN_SNAPSHOTS_FOR_SHARPE observations:
                  a Sharpe off a handful of snapshots describes the sample, not
                  the strategy, and a caveat under it would not stop it being
                  read as a result. */}
              {risk && (
                <>
                  <StatRow
                    label="Sharpe (ann.)"
                    tone={risk.sharpe >= 1 ? "gain" : "info"}
                    value={fmtNum(risk.sharpe)}
                  />
                  <StatRow label="Sortino" value={fmtNum(risk.sortino)} />
                  <StatRow
                    label="Realized Vol"
                    value={fmtPct(risk.annualizedVol * 100, 1)}
                  />
                </>
              )}
              {stats.tail && (
                /* The two extremes bracket the real number; showing only the
                   independent one would quietly understate a concentrated book. */
                <p className="pt-1 text-xs text-muted-foreground">
                  Whole book carried {Math.round(stats.tail.horizonDays)}d to the last
                  expiry, assuming uncorrelated underlyings. Perfectly correlated worst
                  case: {fmtUsd(stats.tail.comonotonicVar95)}.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-2 pt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Realized Track Record
              </p>
              {record.count === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {record.unbooked > 0
                    ? `${record.unbooked} closed position${record.unbooked === 1 ? "" : "s"} had no cost basis, so no result could be booked.`
                    : "No closed trades yet. Archive a position to start building a record."}
                </p>
              ) : (
                <>
                  <StatRow
                    label="Total Realized"
                    tone={record.totalRealized >= 0 ? "gain" : "loss"}
                    value={fmtUsd(record.totalRealized)}
                  />
                  <StatRow
                    label="Win Rate"
                    value={`${fmtPct(record.winRate, 0)} (${record.wins}/${record.count})`}
                  />
                  <StatRow
                    label="Profit Factor"
                    value={record.profitFactor == null ? "No losses yet" : fmtNum(record.profitFactor)}
                  />
                  <StatRow label="Expectancy" value={fmtUsd(record.expectancy)} />
                  <StatRow label="Avg Win" value={fmtUsd(record.avgWin)} />
                  <StatRow label="Avg Loss" value={fmtUsd(-record.avgLoss)} />
                  {record.avgHoldDays != null && (
                    <StatRow label="Avg Hold" value={`${fmtNum(record.avgHoldDays, 1)}d`} />
                  )}
                  {record.returnOnRisk != null && (
                    <StatRow label="Return on Risk" value={fmtPct(record.returnOnRisk, 1)} />
                  )}
                  {record.unbooked > 0 && (
                    <StatRow
                      label="Unbooked (no basis)"
                      tone="muted"
                      value={`${record.unbooked} excluded`}
                    />
                  )}
                  {record.count < 20 && (
                    <p className="flex items-start gap-1.5 pt-1 text-xs text-muted-foreground">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      Only {record.count} closed trade{record.count === 1 ? "" : "s"} — too few
                      to read as edge.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardContent className="pt-5">
            <p className="text-sm text-muted-foreground">
              Add positions to compute risk analytics.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Open trades, filterable by ticker. */}
      <div>
        <SectionTitle
          action={
            <AddTradeDialog
              portfolioId={portfolioId}
              trigger={
                <Button variant="ghost" size="sm">
                  <Plus className="h-4 w-4" /> Add
                </Button>
              }
            />
          }
        >
          Open Trades
        </SectionTitle>
        {positions.length === 0 ? (
          <EmptyState
            title="No open trades"
            hint="Add your first position to begin tracking risk."
          />
        ) : (
          <>
            {tickers.length > 1 && (
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                {tickers.map((tk) => {
                  const active = tickerFilter === tk;
                  return (
                    <button
                      key={tk}
                      type="button"
                      onClick={() => setTickerFilter(active ? null : tk)}
                      className={
                        active
                          ? "rounded-full border border-primary/40 bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary"
                          : "rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
                      }
                    >
                      {tk}
                    </button>
                  );
                })}
                {tickerFilter && (
                  <button
                    type="button"
                    onClick={() => setTickerFilter(null)}
                    className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" /> Clear
                  </button>
                )}
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visiblePositions.map((pos) => (
                <TradeCard key={pos.trade.id} position={pos} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
