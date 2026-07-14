import { useEffect, useMemo } from "react";
import { Rocket, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Metric } from "@/components/ui/metric";
import { Button } from "@/components/ui/button";
import { Chart } from "@/components/charts/Chart";
import { CHART_COLORS } from "@/components/charts/theme";
import { SectionTitle } from "@/components/ui/states";
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
            <div className="mb-3 flex items-center justify-between">
              <SectionTitle>Trade Configuration</SectionTitle>
              <Button
                variant="ghost"
                size="sm"
                className="-mt-2 h-7 text-xs text-muted-foreground"
                onClick={reset}
                title="Clear the sandbox draft"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Reset
              </Button>
            </div>
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
                      <Chart
                        height={380}
                        data={[
                          {
                            type: "scatter",
                            mode: "lines",
                            name: "Payoff at Expiration",
                            x: payoff.prices,
                            y: payoff.pnl,
                            line: { color: CHART_COLORS.brand, width: 3 },
                          },
                          {
                            type: "scatter",
                            mode: "lines",
                            name: "Price Probability",
                            x: payoff.prices,
                            y: payoff.density,
                            yaxis: "y2",
                            fill: "tozeroy",
                            line: { color: "rgba(34,192,138,0.0)" },
                            fillcolor: "rgba(34,192,138,0.18)",
                          },
                        ]}
                        layout={{
                          xaxis: { title: { text: "Underlying Price ($)" }, tickprefix: "$" },
                          yaxis: { title: { text: "P&L ($)" }, tickprefix: "$" },
                          yaxis2: {
                            overlaying: "y",
                            side: "right",
                            showgrid: false,
                            visible: false,
                          },
                          hovermode: "x unified",
                          shapes: [
                            {
                              type: "line",
                              x0: payoff.prices[0],
                              x1: payoff.prices[payoff.prices.length - 1],
                              y0: 0,
                              y1: 0,
                              line: { color: "rgba(255,255,255,0.4)", width: 1, dash: "dash" },
                            },
                            {
                              type: "line",
                              x0: payoff.S0,
                              x1: payoff.S0,
                              yref: "paper",
                              y0: 0,
                              y1: 1,
                              line: { color: CHART_COLORS.amber, width: 1.5, dash: "dot" },
                            },
                          ],
                        }}
                      />
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
                      <div className="overflow-x-auto scrollbar-thin">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                              <th className="py-2">Sector</th>
                              <th className="py-2 text-right">Current</th>
                              <th className="py-2 text-right">Simulated</th>
                              <th className="py-2 text-right">Change</th>
                            </tr>
                          </thead>
                          <tbody>
                            {impact.sectorRows.map((r) => (
                              <tr key={r.sector} className="border-b border-border/40 last:border-0">
                                <td className="py-2">{r.sector}</td>
                                <td className="py-2 text-right tnum">{fmtPct(r.curPct, 1)}</td>
                                <td className="py-2 text-right tnum">{fmtPct(r.simPct, 1)}</td>
                                <td className={`py-2 text-right tnum ${pnlClass(r.change)}`}>
                                  {r.change >= 0 ? "+" : ""}
                                  {r.change.toFixed(1)}%
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
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
