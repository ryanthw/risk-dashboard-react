import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Metric } from "@/components/ui/metric";
import { Chart } from "@/components/charts/Chart";
import { CHART_COLORS, CHART_SEQUENCE } from "@/components/charts/theme";
import { EmptyState, LoadingState, NoPortfolio, SectionTitle } from "@/components/ui/states";
import { useActivePortfolio } from "@/hooks/useActivePortfolio";
import { theoreticalValue } from "@/engine/blackScholes";
import { mean, stdDev } from "@/engine/monteCarlo";
import { erAnn } from "@/engine/portfolio";
import { fmtUsd, fmtPct } from "@/lib/format";

/** Deterministic color per ticker for consistent legends. */
function tickerColor(ticker: string, tickers: string[]): string {
  return CHART_SEQUENCE[tickers.indexOf(ticker) % CHART_SEQUENCE.length];
}

export default function Visuals() {
  const { portfolioId, positions, cash, portValue, isLoading } = useActivePortfolio();

  const uniqueTickers = useMemo(
    () => [...new Set(positions.map((p) => p.trade.ticker))],
    [positions],
  );

  // Aggregated options-only P&L distribution (sum element-wise across legs).
  const agg = useMemo(() => {
    const optionDists = positions
      .filter((p) => p.trade.trade_type !== "shares")
      .map((p) => p.metrics.pnlDist);
    if (optionDists.length === 0) return null;
    const n = optionDists[0].length;
    const total = new Float64Array(n);
    for (const d of optionDists) for (let i = 0; i < n; i++) total[i] += d[i];
    const avg = mean(total);
    const sd = stdDev(total);
    let wins = 0;
    for (let i = 0; i < n; i++) if (total[i] > 0) wins++;
    // Downsample for the histogram.
    const sample: number[] = [];
    for (let i = 0; i < n; i += 10) sample.push(total[i]);
    return { avg, sd, pop: (wins / n) * 100, sample };
  }, [positions]);

  // Stress-test matrix: P&L under simultaneous price & vol shocks.
  const stress = useMemo(() => {
    if (positions.length === 0) return null;
    const priceShifts = Array.from({ length: 14 }, (_, i) => -0.15 + (0.3 * i) / 13);
    const volShifts = Array.from({ length: 10 }, (_, i) => -0.1 + (0.4 * i) / 9);
    const z = volShifts.map((vS) =>
      priceShifts.map((pS) => {
        let pnl = 0;
        for (const { trade, metrics } of positions) {
          const S = trade.underlying_price ?? 0;
          const T = metrics.dte / 365;
          const v0 = theoreticalValue(trade, S, T, trade.iv);
          const vShock = theoreticalValue(trade, S * (1 + pS), T, trade.iv + vS);
          pnl += vShock - v0;
        }
        return pnl;
      }),
    );
    const maxAbs = Math.max(1, ...z.flat().map((v) => Math.abs(v)));
    return {
      z,
      maxAbs,
      x: priceShifts.map((p) => `${(p * 100).toFixed(0)}%`),
      y: volShifts.map((v) => `${(v * 100).toFixed(0)}%`),
    };
  }, [positions]);

  // Greek decay over the next 30 days.
  const decay = useMemo(() => {
    const opts = positions.filter((p) => p.trade.trade_type !== "shares");
    if (opts.length === 0) return null;
    const days = Array.from({ length: 31 }, (_, i) => i);
    const theta: number[] = [];
    const vega: number[] = [];
    for (const d of days) {
      let tTheta = 0;
      let tVega = 0;
      for (const { trade, metrics } of opts) {
        const S = trade.underlying_price ?? 0;
        const Tnew = Math.max(0, (metrics.dte - d) / 365);
        const v0 = theoreticalValue(trade, S, Tnew, trade.iv);
        const vUp = theoreticalValue(trade, S, Tnew, trade.iv + 0.01);
        tVega += (vUp - v0) / (0.01 * 100);
        const vNext = theoreticalValue(trade, S, Math.max(0, Tnew - 1 / 365), trade.iv);
        tTheta += vNext - v0;
      }
      theta.push(tTheta);
      vega.push(tVega);
    }
    return { days, theta, vega };
  }, [positions]);

  // 10-year wealth forecast from annualized expected return.
  const forecast = useMemo(() => {
    const rate = erAnn(positions, cash);
    if (!rate || portValue <= 0) return null;
    const years = Array.from({ length: 11 }, (_, i) => i);
    return {
      rate,
      years,
      target: years.map((y) => portValue * (1 + rate) ** y),
      conservative: years.map((y) => portValue * (1 + rate * 0.7) ** y),
    };
  }, [positions, cash, portValue]);

  if (!portfolioId) return <NoPortfolio />;
  if (isLoading) return <LoadingState />;
  if (positions.length === 0)
    return (
      <EmptyState title="No trades to visualize" hint="Add positions on the Dashboard." />
    );

  const scatter = positions.map((p) => p.trade);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardContent className="pt-5">
            <SectionTitle>Risk-Reward Profile</SectionTitle>
            <Chart
              height={300}
              data={[
                {
                  type: "scatter",
                  mode: "markers",
                  x: positions.map((p) => p.metrics.maxLoss),
                  y: positions.map((p) => p.metrics.maxGain),
                  text: scatter.map((t) => t.ticker),
                  marker: {
                    size: positions.map((p) => 8 + p.metrics.pop * 26),
                    color: scatter.map((t) => tickerColor(t.ticker, uniqueTickers)),
                    opacity: 0.8,
                    line: { color: "rgba(255,255,255,0.2)", width: 1 },
                  },
                  hovertemplate:
                    "<b>%{text}</b><br>Max Loss $%{x:,.0f}<br>Max Gain $%{y:,.0f}<extra></extra>",
                },
              ]}
              layout={{
                xaxis: { title: { text: "Max Loss ($)" }, tickprefix: "$" },
                yaxis: { title: { text: "Max Gain ($)" }, tickprefix: "$" },
                showlegend: false,
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <SectionTitle>Capital at Risk by Expiration</SectionTitle>
            <Chart
              height={300}
              data={uniqueTickers.map((tk) => {
                const legs = positions.filter(
                  (p) => p.trade.ticker === tk && p.trade.trade_type !== "shares",
                );
                return {
                  type: "bar" as const,
                  name: tk,
                  x: legs.map((p) => p.trade.expiration ?? ""),
                  y: legs.map((p) => Math.abs(p.metrics.maxLoss)),
                  marker: { color: tickerColor(tk, uniqueTickers) },
                };
              })}
              layout={{
                barmode: "group",
                xaxis: { title: { text: "Expiration" }, type: "category" },
                yaxis: { title: { text: "Max Loss ($)" }, tickprefix: "$" },
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <SectionTitle>Risk Allocation</SectionTitle>
            <Chart
              height={300}
              data={[
                {
                  type: "pie",
                  hole: 0.45,
                  labels: positions.map((p) => p.trade.ticker),
                  values: positions.map((p) => Math.abs(p.metrics.maxLoss)),
                  marker: { colors: CHART_SEQUENCE },
                  textinfo: "label+percent",
                  textfont: { size: 11 },
                  hovertemplate: "<b>%{label}</b><br>$%{value:,.0f}<extra></extra>",
                },
              ]}
              layout={{ showlegend: false }}
            />
          </CardContent>
        </Card>
      </div>

      {agg && (
        <Card>
          <CardContent className="pt-5">
            <SectionTitle>Aggregated P&L Distribution (Monte Carlo)</SectionTitle>
            <div className="mb-4 grid grid-cols-3 gap-4">
              <Metric label="Agg. Expected Return" value={fmtUsd(agg.avg)} accent="primary" />
              <Metric label="Portfolio Std Dev" value={fmtUsd(agg.sd)} />
              <Metric label="Portfolio POP" value={fmtPct(agg.pop, 1)} accent="gain" />
            </div>
            <Chart
              height={340}
              data={[
                {
                  type: "histogram",
                  x: agg.sample,
                  marker: { color: CHART_COLORS.brand, opacity: 0.85 },
                  hovertemplate: "P&L $%{x:,.0f}<br>%{y} paths<extra></extra>",
                },
              ]}
              layout={{
                xaxis: { title: { text: "P&L at Expiration ($)" }, tickprefix: "$" },
                yaxis: { title: { text: "Frequency" } },
                shapes: [
                  {
                    type: "line",
                    x0: 0,
                    x1: 0,
                    yref: "paper",
                    y0: 0,
                    y1: 1,
                    line: { color: CHART_COLORS.loss, width: 2, dash: "dash" },
                  },
                ],
              }}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Options-only view — share positions are excluded due to their long horizon
              and skew.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {stress && (
          <Card>
            <CardContent className="pt-5">
              <SectionTitle>Stress-Test Matrix</SectionTitle>
              <Chart
                height={340}
                data={[
                  {
                    type: "heatmap",
                    z: stress.z,
                    x: stress.x,
                    y: stress.y,
                    colorscale: "RdYlGn",
                    zmin: -stress.maxAbs,
                    zmax: stress.maxAbs,
                    colorbar: { title: { text: "P&L $" }, thickness: 12 },
                    hovertemplate:
                      "Price %{x}<br>Vol %{y}<br>P&L $%{z:,.0f}<extra></extra>",
                  },
                ]}
                layout={{
                  xaxis: { title: { text: "Price Shift" }, type: "category" },
                  yaxis: { title: { text: "Vol Shift" }, type: "category" },
                }}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Estimated P&L under simultaneous price and volatility shocks.
              </p>
            </CardContent>
          </Card>
        )}

        {decay && (
          <Card>
            <CardContent className="pt-5">
              <SectionTitle>Greek Decay (30 Days)</SectionTitle>
              <Chart
                height={340}
                data={[
                  {
                    type: "scatter",
                    mode: "lines",
                    name: "Total Theta",
                    x: decay.days,
                    y: decay.theta,
                    line: { color: CHART_COLORS.gain, width: 2.5 },
                  },
                  {
                    type: "scatter",
                    mode: "lines",
                    name: "Total Vega",
                    x: decay.days,
                    y: decay.vega,
                    line: { color: CHART_COLORS.violet, width: 2.5 },
                  },
                ]}
                layout={{
                  xaxis: { title: { text: "Days from Now" } },
                  yaxis: { title: { text: "Risk Exposure ($)" } },
                }}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                How portfolio Theta income and Vega risk evolve as expirations approach.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {forecast && (
        <Card>
          <CardContent className="pt-5">
            <SectionTitle>10-Year Wealth Forecast</SectionTitle>
            <Chart
              height={340}
              data={[
                {
                  type: "scatter",
                  mode: "lines",
                  name: `Target (${(forecast.rate * 100).toFixed(1)}% APR)`,
                  x: forecast.years,
                  y: forecast.target,
                  line: { color: CHART_COLORS.gain, width: 2.5 },
                },
                {
                  type: "scatter",
                  mode: "lines",
                  name: "Conservative (70%)",
                  x: forecast.years,
                  y: forecast.conservative,
                  line: { color: CHART_COLORS.brand, width: 2, dash: "dash" },
                },
              ]}
              layout={{
                xaxis: { title: { text: "Year" } },
                yaxis: { title: { text: "Account Balance ($)" }, tickprefix: "$", tickformat: ",.0f" },
                hovermode: "x unified",
              }}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Target assumes full reinvestment at the annualized expected return.
              Conservative realizes 70% of that.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
