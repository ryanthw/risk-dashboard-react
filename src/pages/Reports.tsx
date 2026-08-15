import { useMemo, useState } from "react";
import { FileText, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { EmptyState, LoadingState, NoPortfolio } from "@/components/ui/states";
import {
  ReportFootnote,
  ReportHeader,
  ReportSection,
  ReportSheet,
} from "@/components/reports/ReportSheet";
import { ReportKpis, toneOf, type Kpi } from "@/components/reports/ReportKpis";
import {
  MonthlyPnlBars,
  ReportEquityCurve,
  StrategyPnlBars,
} from "@/components/reports/ReportCharts";
import {
  ClosedTradesTable,
  ExposureTable,
  OpenPositionsTable,
} from "@/components/reports/ReportTables";
import { useActivePortfolio } from "@/hooks/useActivePortfolio";
import { useHistoryTrades, useSnapshots } from "@/api/history";
import { useCashFlows } from "@/api/cashFlows";
import { computeTwr, riskAdjusted, MIN_SNAPSHOTS_FOR_SHARPE } from "@/engine/twr";
import { trackRecord, trackRecordByStrategy } from "@/engine/trackRecord";
import {
  grossExposure,
  leverageRatio,
  netLiquidity,
  portfolioValue,
} from "@/engine/portfolio";
import { undefinedRiskCount } from "@/engine/portfolioRisk";
import {
  PERIOD_KEYS,
  PERIOD_LABELS,
  concentration,
  exposureByTicker,
  monthlyRealized,
  notionalExposure,
  resolvePeriod,
  snapshotsInPeriod,
  tradesInPeriod,
  type PeriodKey,
} from "@/engine/reportMetrics";
import { fmtMultiple, fmtNum, fmtPct, fmtUsd } from "@/lib/format";

const longDate = (d: Date) =>
  d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });

/**
 * Days of history before the report will print an annualized figure.
 *
 * The engine annualizes from 60 days, which is right for an on-screen metric
 * you can re-read tomorrow. It is wrong on a statement: compounding nine good
 * weeks produced "320% annualized" on the first run of this page, a number
 * that is arithmetically correct and tells the reader nothing true. Half a
 * year is the point where the figure stops being dominated by the window.
 */
const MIN_DAYS_TO_ANNUALIZE = 180;

/** Below this span, ratio metrics are shown but labelled as unstable. */
const SHORT_WINDOW_DAYS = 180;

export default function Reports() {
  const { portfolioId, portfolio, positions, cash, isLoading } = useActivePortfolio();
  const { data: snapshots, isLoading: loadingSnaps } = useSnapshots(portfolioId);
  const { data: closed, isLoading: loadingClosed } = useHistoryTrades(portfolioId);
  const { data: flows } = useCashFlows(portfolioId);

  const [periodKey, setPeriodKey] = useState<PeriodKey>("3M");

  // Pinned once per render pass so the header timestamp, the period bounds and
  // every filtered series agree with each other. Recomputing `new Date()` at
  // each use site lets a report straddle midnight and disagree with itself.
  const generatedAt = useMemo(() => new Date(), [periodKey, snapshots, closed]);
  const period = useMemo(
    () => resolvePeriod(periodKey, generatedAt),
    [periodKey, generatedAt],
  );

  const windowSnaps = useMemo(
    () => snapshotsInPeriod(snapshots ?? [], period),
    [snapshots, period],
  );
  const windowTrades = useMemo(
    () => tradesInPeriod(closed ?? [], period),
    [closed, period],
  );

  const twr = useMemo(
    () => computeTwr(windowSnaps, flows ?? []),
    [windowSnaps, flows],
  );
  const risk = useMemo(() => (twr ? riskAdjusted(twr) : null), [twr]);
  const record = useMemo(() => trackRecord(windowTrades), [windowTrades]);
  const byStrategy = useMemo(() => trackRecordByStrategy(windowTrades), [windowTrades]);
  const months = useMemo(() => monthlyRealized(windowTrades), [windowTrades]);

  const netLiq = useMemo(() => netLiquidity(positions, cash), [positions, cash]);
  const portValue = useMemo(() => portfolioValue(positions, cash), [positions, cash]);
  const exposures = useMemo(
    () => exposureByTicker(positions, netLiq),
    [positions, netLiq],
  );
  const notional = useMemo(() => notionalExposure(exposures, netLiq), [exposures, netLiq]);
  const conc = useMemo(() => concentration(positions, portValue), [positions, portValue]);

  // The account's actual leverage: money that can be lost over portfolio value.
  // Bounded at 1.0x without margin, so a reading above it means either a naked
  // short leg or a real borrow — both worth seeing immediately.
  const lev = useMemo(() => leverageRatio(positions, cash), [positions, cash]);
  const atRisk = useMemo(() => grossExposure(positions), [positions]);
  const undefinedRisk = useMemo(() => undefinedRiskCount(positions), [positions]);

  if (!portfolioId) return <NoPortfolio />;
  if (isLoading || loadingSnaps || loadingClosed)
    return <LoadingState label="Assembling report…" />;

  const hasSeries = windowSnaps.length >= 2;
  const rangeStart = hasSeries ? new Date(windowSnaps[0].ts) : period.start;
  const range = `${rangeStart ? longDate(rangeStart) : "—"} – ${longDate(period.end)}`;

  const kpis: Kpi[] = [
    {
      label: "Time-Weighted Return",
      value: twr ? fmtPct(twr.totalReturn * 100, 1) : "—",
      hint: twr
        ? twr.annualized != null && twr.spanDays >= MIN_DAYS_TO_ANNUALIZE
          ? `${fmtPct(twr.annualized * 100, 0)} annualized`
          : `over ${twr.spanDays} days`
        : "needs 2+ snapshots",
      tone: toneOf(twr?.totalReturn),
    },
    {
      label: "Trading P/L",
      value: twr ? fmtUsd(twr.tradingPnl) : "—",
      hint: twr ? `${fmtUsd(twr.netContributions)} contributed` : undefined,
      tone: toneOf(twr?.tradingPnl),
    },
    {
      label: "Net Liquidity",
      value: fmtUsd(netLiq),
      hint: `${fmtUsd(cash)} cash · ${netLiq > 0 ? fmtPct((cash / netLiq) * 100, 0) : "—"}`,
    },
    {
      label: "Max Drawdown",
      value: twr ? fmtPct(-twr.maxDrawdown, 1) : "—",
      hint: twr && twr.currentDrawdown > 0.05
        ? `${fmtPct(twr.currentDrawdown, 1)} from peak now`
        : "at high-water mark",
      tone: twr && twr.maxDrawdown > 0 ? "loss" : "neutral",
    },
    {
      label: "Realized P/L",
      value: fmtUsd(record.totalRealized),
      hint: `${record.count} closed · ${fmtUsd(record.expectancy)} per trade`,
      tone: toneOf(record.totalRealized),
    },
    {
      label: "Win Rate",
      value: record.count ? fmtPct(record.winRate, 0) : "—",
      hint: record.count ? `${record.wins}W / ${record.losses}L` : "no closes in period",
    },
    {
      label: "Profit Factor",
      value: record.profitFactor == null ? "—" : fmtNum(record.profitFactor, 2),
      hint:
        record.profitFactor == null
          ? "no losing trades"
          : `${fmtUsd(record.avgWin)} avg win · ${fmtUsd(-record.avgLoss)} avg loss`,
    },
    {
      label: "Sharpe",
      value: risk ? fmtNum(risk.sharpe, 2) : "—",
      hint: risk
        ? `${fmtNum(risk.sortino, 2)} Sortino · ${fmtPct(risk.annualizedVol * 100, 0)} vol`
        : `needs ${MIN_SNAPSHOTS_FOR_SHARPE} snapshots`,
      tone: risk ? toneOf(risk.sharpe) : "neutral",
    },
    {
      label: "Leverage",
      value: Number.isFinite(lev) ? fmtMultiple(lev, 2) : "—",
      hint: undefinedRisk
        ? `${fmtUsd(atRisk)} at risk, excl. ${undefinedRisk} undefined-risk`
        : `${fmtUsd(atRisk)} at risk · 1.00x is fully deployed`,
      // Without margin this cannot exceed 1.0x, so a reading above it is a
      // finding rather than a scale point.
      tone: undefinedRisk ? "loss" : lev > 1 ? "loss" : "neutral",
    },
    {
      label: "Delta Notional",
      value: fmtUsd(notional.gross),
      hint: Number.isFinite(notional.grossOfNav)
        ? `${fmtMultiple(notional.grossOfNav, 2)} NAV — underlying the book tracks`
        : undefined,
    },
    {
      label: "SPY-Equivalent",
      value: fmtUsd(notional.betaWeighted),
      hint: Number.isFinite(notional.betaWeightedOfNav)
        ? `${fmtMultiple(notional.betaWeightedOfNav, 2)} NAV, beta-weighted`
        : undefined,
    },
    {
      label: "Concentration",
      value: conc.names ? fmtNum(conc.hhi, 2) : "—",
      hint: conc.names
        ? `${fmtNum(conc.effectiveNames, 1)} effective names of ${conc.names}` +
          (conc.topTicker ? ` · ${conc.topTicker} ${fmtPct(conc.topPct, 0)}` : "")
        : "no capital at risk",
      tone: conc.hhi > 0.25 ? "loss" : "neutral",
    },
  ];

  return (
    <div className="mx-auto max-w-[9in] space-y-4">
      {/* Controls — chrome, never printed. */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <FileText className="h-4 w-4 shrink-0 text-primary" />
          Print-ready performance statement · exactly what you see below lands in the PDF
        </p>
        <div className="flex items-center gap-3">
          <div
            role="group"
            aria-label="Reporting period"
            className="flex rounded-md border border-border p-0.5"
          >
            {PERIOD_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setPeriodKey(k)}
                aria-pressed={periodKey === k}
                title={PERIOD_LABELS[k]}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium transition-colors duration-fast",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  periodKey === k
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {k}
              </button>
            ))}
          </div>
          <Button size="sm" onClick={() => window.print()}>
            <Printer className="mr-1.5 h-3.5 w-3.5" />
            Export PDF
          </Button>
        </div>
      </div>

      <ReportSheet>
        <ReportHeader
          portfolioName={portfolio?.name ?? "Portfolio"}
          periodLabel={PERIOD_LABELS[periodKey]}
          range={range}
          generatedAt={generatedAt}
        />

        <ReportKpis items={kpis} />

        {/* The caveat belongs beside the numbers, not in a methodology
            appendix — a 5.6 Sharpe off nine weeks reads as a finding unless
            the page says otherwise where the reader is looking. */}
        {twr && twr.spanDays < SHORT_WINDOW_DAYS && (
          <ReportFootnote>
            This period covers {twr.spanDays} days. Ratio measures — Sharpe, Sortino,
            profit factor — and any annualized figure are dominated by the length of the
            window at this sample size and should be read as descriptive of the period,
            not predictive of the strategy.
          </ReportFootnote>
        )}

        <ReportSection
          title="Net Liquidity"
          hint={hasSeries ? `${windowSnaps.length} snapshots` : undefined}
        >
          {hasSeries ? (
            <>
              <ReportEquityCurve snapshots={windowSnaps} />
              <ReportFootnote>
                Long option positions are carried at modelled value, not a live market
                mark, so this line is an estimate wherever the book holds them.
                Time-weighted return chains the snapshot-to-snapshot moves with deposits
                and withdrawals removed.
              </ReportFootnote>
            </>
          ) : (
            <p className="py-6 text-center text-[11px] text-[#7b8794]">
              Not enough snapshots in this period to draw a curve.
            </p>
          )}
        </ReportSection>

        <ReportSection
          title="Realized P/L by Strategy"
          hint={`${record.count} closed in period`}
        >
          {byStrategy.length > 0 ? (
            <StrategyPnlBars records={byStrategy} />
          ) : (
            <p className="py-6 text-center text-[11px] text-[#7b8794]">
              No positions closed in this period.
            </p>
          )}
        </ReportSection>

        {months.length > 0 && (
          <ReportSection title="Realized P/L by Month">
            <MonthlyPnlBars months={months} />
          </ReportSection>
        )}

        <ReportSection
          title="Risk & Concentration"
          hint={`${fmtMultiple(lev, 2)} leverage · ${fmtMultiple(notional.grossOfNav, 2)} notional`}
        >
          {exposures.length > 0 ? (
            <>
              <ExposureTable exposures={exposures} />
              <ReportFootnote>
                <strong>At risk</strong> is the money that can actually be lost — each
                leg's maximum loss, summed per ticker — and it is what leverage and HHI
                are measured over. Without margin it cannot exceed the account, so
                leverage is bounded at 1.00x.{" "}
                <strong>Notional</strong> is Black-Scholes delta times spot, netted
                across a ticker's legs: how much underlying the book moves with, which
                for in-the-money long calls is several times what they cost. It is not
                borrowing and nothing beyond the premium is at stake. Beta is the value
                stored on each position and is unreliable for thinly-traded names — read
                the SPY-equivalent column as an order of magnitude, not a measurement.
              </ReportFootnote>
            </>
          ) : (
            <p className="py-6 text-center text-[11px] text-[#7b8794]">
              No open positions carrying exposure.
            </p>
          )}
        </ReportSection>

        <ReportSection title="Open Positions" hint={`${positions.length} legs`}>
          {positions.length > 0 ? (
            <OpenPositionsTable positions={positions} />
          ) : (
            <p className="py-6 text-center text-[11px] text-[#7b8794]">
              The book is flat.
            </p>
          )}
        </ReportSection>

        <ReportSection
          title="Closed Trades"
          hint={`${windowTrades.length} in period`}
          breakBefore
          avoidBreak={false}
        >
          {windowTrades.length > 0 ? (
            <>
              <ClosedTradesTable trades={windowTrades} />
              {record.unbooked > 0 && (
                <ReportFootnote>
                  {record.unbooked} closed position
                  {record.unbooked === 1 ? "" : "s"} had no determinable P&L and{" "}
                  {record.unbooked === 1 ? "is" : "are"} excluded from every statistic
                  above rather than counted as zero.
                </ReportFootnote>
              )}
            </>
          ) : (
            <p className="py-6 text-center text-[11px] text-[#7b8794]">
              No positions closed in this period.
            </p>
          )}
        </ReportSection>

        <footer className="mt-6 border-t border-[#dfe3e8] pt-2 text-[9px] text-[#7b8794]">
          {portfolio?.name} · {PERIOD_LABELS[periodKey]} · generated{" "}
          {generatedAt.toLocaleString("en-US", {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}{" "}
          · Risk Dashboard
        </footer>
      </ReportSheet>

      {!hasSeries && !loadingSnaps && (
        <div className="no-print">
          <EmptyState
            title="Sparse snapshot history"
            hint="Return metrics need at least two snapshots inside the period. Use Refresh on the top bar, or widen the period."
          />
        </div>
      )}
    </div>
  );
}
