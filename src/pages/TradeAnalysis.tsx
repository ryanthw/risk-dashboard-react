import { useEffect, useMemo } from "react";
import { Rocket, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Metric } from "@/components/ui/metric";
import { Button } from "@/components/ui/button";
import type { EChartsOption } from "echarts";
import { EChart } from "@/components/charts/EChart";
import { CHART_COLORS } from "@/components/charts/theme";
import { X_NAME_GAP, axisUsd, tipUsd, valueAxis } from "@/components/charts/echartsTheme";
import { SectionTitle } from "@/components/ui/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { TradeFields, type TradeDraft } from "@/components/trades/TradeFields";
import { useTradeSandboxStore, SANDBOX_TTL } from "@/store/tradeSandbox";
import { useActivePortfolio } from "@/hooks/useActivePortfolio";
import { useUpsertTrade } from "@/api/trades";
import { deriveTradeMetrics } from "@/engine/trade";
import { payoffAtPrices } from "@/engine/monteCarlo";
import {
  betaWeightedDelta,
  grossExposure,
  hhi,
  tradeBetaDelta,
} from "@/engine/portfolio";
import { isSpread, type Trade } from "@/types";
import { fmtUsd, fmtPct, fmtNum, pnlClass } from "@/lib/format";

/** Build a Trade-shaped object from a sandbox draft for the engine. */
function draftToTrade(draft: TradeDraft, portfolioId: string): Trade {
  const isShares = draft.trade_type === "shares";
  return {
    id: "sandbox",
    user_id: "sandbox",
    portfolio_id: portfolioId,
    trade_type: draft.trade_type,
    ticker: draft.ticker.toUpperCase() || "—",
    qty: draft.qty,
    strike: isShares || draft.strike <= 0 ? null : draft.strike,
    strike_2: isSpread(draft.trade_type) && draft.strike_2 > 0 ? draft.strike_2 : null,
    premium: isShares ? null : draft.premium,
    cost_basis: isShares && draft.cost_basis > 0 ? draft.cost_basis : null,
    iv: draft.iv,
    expiration: isShares ? null : draft.expiration,
    underlying_price: draft.underlying_price ?? 0,
    sector: draft.sector,
    beta: draft.beta,
    opened_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** Lognormal PDF for the terminal-price probability overlay. */
function lognormPdf(x: number, mu: number, s: number): number {
  if (x <= 0 || s <= 0) return 0;
  const z = (Math.log(x) - mu) / s;
  return Math.exp(-0.5 * z * z) / (x * s * Math.sqrt(2 * Math.PI));
}

export default function TradeAnalysis() {
  const { portfolioId, positions } = useActivePortfolio();
  const draft = useTradeSandboxStore((s) => s.draft);
  const setDraft = useTradeSandboxStore((s) => s.setDraft);
  const reset = useTradeSandboxStore((s) => s.reset);
  const updatedAt = useTradeSandboxStore((s) => s.updatedAt);
  const upsert = useUpsertTrade();

  // Clear a stale draft on entry; fresh drafts survive tab navigation.
  useEffect(() => {
    if (Date.now() - updatedAt > SANDBOX_TTL) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasPrice = (draft.underlying_price ?? 0) > 0 && !!draft.ticker;

  const trade = useMemo(
    () => draftToTrade(draft, portfolioId ?? "sandbox"),
    [draft, portfolioId],
  );

  const metrics = useMemo(
    () => (hasPrice ? deriveTradeMetrics(trade, 40_000) : null),
    [trade, hasPrice],
  );

  // Payoff diagram + lognormal probability overlay.
  const payoff = useMemo(() => {
    if (!hasPrice) return null;
    const S0 = trade.underlying_price ?? 0;
    const prices: number[] = [];
    for (let i = 0; i < 200; i++) prices.push(S0 * 0.7 + ((S0 * 0.6) / 199) * i);
    const pnl = Array.from(payoffAtPrices(trade, prices));
    const T = trade.trade_type === "shares" ? 1 : Math.max((metrics?.dte ?? 0) / 365, 1e-6);
    const sigmaT = trade.iv * Math.sqrt(T);
    const mu = Math.log(S0) - 0.5 * trade.iv * trade.iv * T;
    const density = prices.map((p) => lognormPdf(p, mu, sigmaT));
    return { prices, pnl, density, S0 };
  }, [trade, hasPrice, metrics?.dte]);

  const payoffOption = useMemo<EChartsOption>(() => {
    if (!payoff) return {};
    return {
      grid: { left: 58, right: 20, top: 32, bottom: 44, containLabel: true },
      legend: { top: 0, left: 0 },
      xAxis: {
        ...valueAxis("Underlying Price ($)", axisUsd),
        nameGap: X_NAME_GAP,
        min: payoff.prices[0],
        max: payoff.prices[payoff.prices.length - 1],
      },
      // Two y-axes: P&L on the left, the probability density overlaid and
      // hidden on the right — it shares the x range but not the scale.
      yAxis: [
        valueAxis("P&L ($)", axisUsd),
        {
          type: "value" as const,
          show: false,
          splitLine: { show: false },
          // `show: false` hides the axis but not its crosshair readout, which
          // leaked a raw density value onto the right edge.
          axisPointer: { show: false },
        },
      ],
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        // Density is an unlabelled shape cue, not a figure worth reading.
        formatter: (params: unknown) => {
          const arr = params as Array<{
            seriesName: string;
            value: [number, number];
            marker: string;
          }>;
          const pnlPt = arr.find((p) => p.seriesName === "Payoff at Expiration");
          if (!pnlPt) return "";
          return (
            `Underlying ${tipUsd(pnlPt.value[0])}<br/>` +
            `${pnlPt.marker}P&L <b>${tipUsd(pnlPt.value[1])}</b>`
          );
        },
      },
      series: [
        {
          type: "line",
          name: "Price Probability",
          yAxisIndex: 1,
          data: payoff.prices.map((p, i) => [p, payoff.density[i]]),
          showSymbol: false,
          lineStyle: { width: 0 },
          areaStyle: { color: "rgba(34,192,138,0.18)" },
          silent: true,
          z: 1,
        },
        {
          type: "line",
          name: "Payoff at Expiration",
          data: payoff.prices.map((p, i) => [p, payoff.pnl[i]]),
          showSymbol: false,
          lineStyle: { color: CHART_COLORS.brand, width: 3 },
          itemStyle: { color: CHART_COLORS.brand },
          z: 3,
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            data: [
              // Break-even.
              {
                yAxis: 0,
                lineStyle: { color: "rgba(255,255,255,0.4)", width: 1, type: "dashed" },
              },
              // Spot at entry.
              {
                xAxis: payoff.S0,
                lineStyle: { color: CHART_COLORS.amber, width: 1.5, type: "dotted" },
              },
            ],
          },
        },
      ],
    };
  }, [payoff]);

  // Portfolio impact.
  const impact = useMemo(() => {
    if (!metrics) return null;
    const curDelta = betaWeightedDelta(positions);
    const curHhi = hhi(positions);
    const curGross = grossExposure(positions);
    const newDelta = tradeBetaDelta(trade);

    // Simulated HHI with the new ticker exposure added.
    const tickerExp: Record<string, number> = {};
    for (const { trade: t, metrics: m } of positions) {
      if (Number.isFinite(m.maxLoss))
        tickerExp[t.ticker] = (tickerExp[t.ticker] ?? 0) + m.maxLoss;
    }
    if (Number.isFinite(metrics.maxLoss))
      tickerExp[trade.ticker] = (tickerExp[trade.ticker] ?? 0) + metrics.maxLoss;
    const newTotal = Object.values(tickerExp).reduce((a, b) => a + b, 0);
    const newHhi = newTotal > 0
      ? Object.values(tickerExp).reduce((a, v) => a + (v / newTotal) ** 2, 0)
      : 0;

    // Sector shift.
    const sectors: Record<string, number> = {};
    for (const { trade: t, metrics: m } of positions) {
      if (Number.isFinite(m.maxLoss))
        sectors[t.sector] = (sectors[t.sector] ?? 0) + m.maxLoss;
    }
    const totalExp = Object.values(sectors).reduce((a, b) => a + b, 0);
    const newExp = Number.isFinite(metrics.maxLoss) ? metrics.maxLoss : 0;
    const allSectors = [...new Set([...Object.keys(sectors), trade.sector])];
    const sectorRows = allSectors.map((s) => {
      const cur = sectors[s] ?? 0;
      const curPct = totalExp > 0 ? (cur / totalExp) * 100 : 0;
      const sim = cur + (s === trade.sector ? newExp : 0);
      const simPct = totalExp + newExp > 0 ? (sim / (totalExp + newExp)) * 100 : 0;
      return { sector: s, curPct, simPct, change: simPct - curPct };
    });

    return { curDelta, newDelta, curHhi, newHhi, curGross, newExp, sectorRows };
  }, [metrics, positions, trade]);

  const handleExecute = async () => {
    if (!portfolioId) {
      toast.error("Select a portfolio first");
      return;
    }
    if (isSpread(draft.trade_type) && draft.strike === draft.strike_2) {
      toast.error("Spread strikes must differ");
      return;
    }
    try {
      await upsert.mutateAsync({
        portfolio_id: portfolioId,
        trade_type: draft.trade_type,
        ticker: draft.ticker.toUpperCase(),
        qty: draft.qty,
        strike: draft.trade_type === "shares" || draft.strike <= 0 ? null : draft.strike,
        strike_2:
          isSpread(draft.trade_type) && draft.strike_2 > 0 ? draft.strike_2 : null,
        premium: draft.trade_type === "shares" ? null : draft.premium,
        iv: draft.iv,
        expiration: draft.trade_type === "shares" ? null : draft.expiration,
        underlying_price: draft.underlying_price,
        sector: draft.sector,
        beta: draft.beta,
      });
      toast.success(`Added ${draft.ticker.toUpperCase()} to portfolio`);
    } catch (e) {
      toast.error("Could not execute", String((e as Error).message));
    }
  };

  return (
    <div className="mx-auto max-w-7xl">
      <p className="mb-4 text-sm text-muted-foreground">
        Simulate a trade and see its risk profile and portfolio impact before execution.
      </p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[340px_1fr]">
        {/* Inputs */}
        <Card className="h-fit">
          <CardContent className="pt-5">
            <SectionTitle
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={reset}
                  title="Clear the sandbox draft"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Reset
                </Button>
              }
            >
              Trade Configuration
            </SectionTitle>
            <TradeFields draft={draft} onChange={setDraft} />
          </CardContent>
        </Card>

        {/* Analysis */}
        <div className="space-y-6">
          {!hasPrice ? (
            <Card>
              <CardContent className="py-16 text-center text-sm text-muted-foreground">
                Enter a ticker and fetch (or type) an underlying price to begin analysis.
              </CardContent>
            </Card>
          ) : (
            metrics && (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Metric
                    label="Expected Value"
                    value={fmtUsd(metrics.expectedProfit)}
                    accent={metrics.expectedProfit >= 0 ? "gain" : "loss"}
                  />
                  <Metric label="Prob. of Profit" value={fmtPct(metrics.pop * 100, 1)} />
                  <Metric label="Max Gain" value={fmtUsd(metrics.maxGain)} />
                  <Metric
                    label="Max Loss"
                    value={Number.isFinite(metrics.maxLoss) ? fmtUsd(metrics.maxLoss) : "∞"}
                    accent="loss"
                  />
                  <Metric label="VaR (95%)" value={fmtUsd(metrics.var95)} />
                  <Metric label="CVaR (95%)" value={fmtUsd(metrics.cvar95)} />
                  <Metric label="Kelly" value={fmtPct(metrics.kelly * 100, 1)} />
                  <Metric label="Beta-W. Delta" value={fmtNum(tradeBetaDelta(trade), 1)} />
                </div>

                {portfolioId && (
                  <Button onClick={handleExecute} disabled={upsert.isPending} className="w-full">
                    <Rocket className="h-4 w-4" /> Execute & Save to Portfolio
                  </Button>
                )}

                {/* Payoff diagram */}
                {payoff && (
                  <Card>
                    <CardContent className="pt-5">
                      <SectionTitle>Payoff Diagram & Price Probability</SectionTitle>
                      <EChart height={380} option={payoffOption} />
                    </CardContent>
                  </Card>
                )}

                {/* Portfolio impact */}
                {impact && positions.length > 0 && (
                  <Card>
                    <CardContent className="pt-5">
                      <SectionTitle>Impact on Portfolio</SectionTitle>
                      <div className="mb-4 grid grid-cols-3 gap-3">
                        <Metric
                          label="Portfolio Delta"
                          value={fmtNum(impact.curDelta, 1)}
                          delta={`${impact.newDelta >= 0 ? "+" : ""}${impact.newDelta.toFixed(1)}`}
                          deltaPositive={impact.newDelta >= 0}
                        />
                        <Metric
                          label="Portfolio HHI"
                          value={fmtNum(impact.curHhi)}
                          delta={`${impact.newHhi - impact.curHhi >= 0 ? "+" : ""}${(impact.newHhi - impact.curHhi).toFixed(2)}`}
                          deltaPositive={impact.newHhi - impact.curHhi <= 0}
                        />
                        <Metric
                          label="Gross Exposure"
                          value={fmtUsd(impact.curGross, true)}
                          delta={`+${fmtUsd(impact.newExp, true)}`}
                          deltaPositive={false}
                        />
                      </div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Sector Exposure Shift
                      </p>
                      {/* Flush to the card's own padding, so no cell inset. */}
                      <TableWrap>
                        <Table className="[&_td]:px-0 [&_th]:px-0">
                          <TableHeader>
                            <tr>
                              <TableHead>Sector</TableHead>
                              <TableHead right>Current</TableHead>
                              <TableHead right>Simulated</TableHead>
                              <TableHead right>Change</TableHead>
                            </tr>
                          </TableHeader>
                          <TableBody>
                            {impact.sectorRows.map((r) => (
                              <TableRow key={r.sector}>
                                <TableCell>{r.sector}</TableCell>
                                <TableCell right>{fmtPct(r.curPct, 1)}</TableCell>
                                <TableCell right>{fmtPct(r.simPct, 1)}</TableCell>
                                <TableCell right className={pnlClass(r.change)}>
                                  {r.change >= 0 ? "+" : ""}
                                  {r.change.toFixed(1)}%
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableWrap>
                    </CardContent>
                  </Card>
                )}
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}
