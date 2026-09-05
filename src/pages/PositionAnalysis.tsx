import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChartCandlestick } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Metric } from "@/components/ui/metric";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "@/components/ui/table";
import { EmptyState, LoadingState, SectionTitle } from "@/components/ui/states";
import { PayoffChart } from "@/components/position/PayoffChart";
import { useActivePortfolio } from "@/hooks/useActivePortfolio";
import { usePositionGreeks } from "@/api/positionGreeks";
import { cn } from "@/lib/cn";
import { fmtNum, fmtUsd, pnlClass } from "@/lib/format";
import {
  asOfDates,
  bookGreeks,
  bookPosition,
  breakevens as findBreakevens,
  buildBook,
  curveAt,
  curveExtremes,
  priceGrid,
  terminalDensity,
  tickersInBook,
  type ValuationSource,
} from "@/engine/positionAnalysis";
import { TRADE_TYPE_LABELS, isSpread, type Trade } from "@/types";

/**
 * LV / BS provenance tag. Deliberately quiet — it answers "am I looking at the
 * market's number or the model's?" at a glance without competing with the
 * figure it qualifies.
 */
function SourceTag({ source }: { source: ValuationSource }) {
  if (source === "exact") return null;
  const live = source === "live";
  return (
    <span
      title={
        live
          ? "Live greeks and IV from the Public option chain"
          : "Black-Scholes on the IV stored with the trade — no live quote resolved"
      }
      className={cn(
        "ml-1.5 rounded px-1 py-px align-middle text-[0.6rem] font-semibold tracking-wide",
        live ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {live ? "LV" : "BS"}
    </span>
  );
}

/** Strike column: spreads read as a pair, singles as one number. */
function strikeLabel(t: Trade): string {
  if (t.trade_type === "shares") return "—";
  if (isSpread(t.trade_type) && t.strike_2)
    return `${fmtNum(Math.min(t.strike ?? 0, t.strike_2), 2)} / ${fmtNum(Math.max(t.strike ?? 0, t.strike_2), 2)}`;
  return t.strike ? fmtNum(t.strike, 2) : "—";
}

export default function PositionAnalysis() {
  const { trades, isLoading, portfolioId } = useActivePortfolio();
  const [ticker, setTicker] = useState<string | null>(null);
  const [asOfIdx, setAsOfIdx] = useState(0);

  const tickers = useMemo(() => tickersInBook(trades), [trades]);

  // Land on a ticker rather than an empty prompt when there is only one, and
  // recover when the selected one leaves the book (closed, or portfolio swap).
  useEffect(() => {
    if (ticker && tickers.includes(ticker)) return;
    setTicker(tickers.length ? tickers[0] : null);
  }, [tickers, ticker]);

  const myTrades = useMemo(
    () => (ticker ? trades.filter((t) => t.ticker.toUpperCase() === ticker) : []),
    [trades, ticker],
  );

  const { quotes, isFetching } = usePositionGreeks(myTrades, !!ticker);

  const book = useMemo(
    () => (ticker ? buildBook(trades, ticker, quotes) : null),
    [trades, ticker, quotes],
  );

  const dates = useMemo(() => (book ? asOfDates(book) : []), [book]);

  // The date bar is rebuilt per ticker, so an index from the previous ticker
  // can point past the end of the new one's expirations.
  const asOf = dates[Math.min(asOfIdx, dates.length - 1)] ?? dates[0] ?? null;
  useEffect(() => setAsOfIdx(0), [ticker]);

  const chart = useMemo(() => {
    if (!book || !asOf || book.spot <= 0) return null;
    const prices = priceGrid(book);
    if (!prices.length) return null;
    const pnl = curveAt(book, asOf.ms, prices);
    const today = asOf.date == null ? null : curveAt(book, Date.now(), prices);
    return {
      prices,
      pnl,
      today,
      density: terminalDensity(book, asOf, prices),
      bes: findBreakevens(prices, pnl),
      extremes: curveExtremes(prices, pnl),
    };
  }, [book, asOf]);

  const stats = useMemo(() => {
    if (!book) return null;
    return { g: bookGreeks(book, quotes), pos: bookPosition(book) };
  }, [book, quotes]);

  if (!portfolioId) {
    return <EmptyState title="No portfolio selected" hint="Pick a portfolio to analyze." />;
  }
  if (isLoading) return <LoadingState label="Loading positions…" />;

  if (!tickers.length) {
    return (
      <EmptyState
        icon={<ChartCandlestick className="h-8 w-8" />}
        title="No open positions"
        hint="Position Analysis aggregates every open position on a ticker into one payoff curve. Add a trade to see it."
      />
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <ChartCandlestick className="h-4 w-4 shrink-0 text-primary" />
          Every open position on one ticker, combined into a single payoff curve · valued at any
          date up to the last expiration
        </p>
        <div className="flex items-center gap-3">
          {book && book.spot > 0 && (
            <span className="text-xs text-muted-foreground tnum">
              {book.ticker} {fmtUsd(book.spot)}
            </span>
          )}
          <Select value={ticker ?? undefined} onValueChange={setTicker}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Select a ticker" />
            </SelectTrigger>
            <SelectContent>
              {tickers.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {book && book.basisMissing.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200/80">
          <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-amber-400" />
          <p>
            <span className="font-medium text-amber-200">
              {book.basisMissing.length} share lot
              {book.basisMissing.length === 1 ? "" : "s"} priced off the current mark.
            </span>{" "}
            No cost basis is recorded, so the curve&rsquo;s <em>shape</em> is right but its level
            is anchored at today&rsquo;s spot rather than what you paid. Enter the basis on the
            Basis Tracker to fix the P&amp;L.
          </p>
        </div>
      )}

      {!chart ? (
        <EmptyState
          title="No price for this ticker"
          hint="Refresh market data to pull a spot price, then the payoff curve can be drawn."
        />
      ) : (
        <>
          <Card>
            <CardContent className="pt-5">
              <SectionTitle
                action={
                  <span className="text-[0.7rem] text-muted-foreground">
                    {asOf?.date
                      ? `${asOf.daysOut} days out`
                      : "marked to model at today's date"}
                    {isFetching && " · refreshing quotes"}
                  </span>
                }
              >
                {book!.ticker} payoff
                <SourceTag source={book!.allLive ? "live" : "model"} />
              </SectionTitle>

              <PayoffChart
                prices={chart.prices}
                pnl={chart.pnl}
                today={chart.today}
                density={chart.density}
                spot={book!.spot}
                breakevens={chart.bes}
                asOfLabel={asOf!.label}
              />

              {/* The expiration bar. Buttons rather than Radix Tabs: the panel
                  below is one chart re-valued, not a set of tab panels, and
                  Tabs would put the whole chart in a role="tabpanel" it isn't. */}
              <div
                role="group"
                aria-label="Valuation date"
                className="mt-3 flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1"
              >
                {dates.map((d, i) => (
                  <button
                    key={d.date ?? "today"}
                    onClick={() => setAsOfIdx(i)}
                    aria-pressed={i === asOfIdx}
                    className={cn(
                      "rounded-md px-3 py-1 text-sm font-medium transition-all",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      i === asOfIdx
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {d.label}
                    {d.date && (
                      <span className="ml-1.5 text-[0.65rem] text-muted-foreground tnum">
                        {d.daysOut}d
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Max profit"
              accent="gain"
              value={
                chart.extremes.profitUncapped ? "Uncapped" : fmtUsd(chart.extremes.maxProfit)
              }
              hint={
                chart.extremes.profitUncapped
                  ? "Still climbing at the edge of the modelled range"
                  : `At ${asOf!.label}, across the modelled price range`
              }
            />
            <Metric
              label="Max loss"
              accent="loss"
              value={chart.extremes.lossUncapped ? "Uncapped" : fmtUsd(chart.extremes.maxLoss)}
              hint={
                chart.extremes.lossUncapped
                  ? "Still falling at the edge of the modelled range"
                  : `At ${asOf!.label}, across the modelled price range`
              }
            />
            <Metric
              label="P&L now"
              value={fmtUsd(stats!.pos.pnl)}
              className={pnlClass(stats!.pos.pnl)}
              hint={`Cost ${fmtUsd(stats!.pos.cost)} · mark ${fmtUsd(stats!.pos.value)}`}
            />
            <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
              <p className="text-[0.7rem] font-medium uppercase tracking-wider text-muted-foreground">
                Greeks
                <SourceTag source={stats!.g.source} />
              </p>
              <div className="mt-2 space-y-1 text-sm tnum">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Delta</span>
                  <span className="font-medium">{fmtNum(stats!.g.delta, 1)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Theta</span>
                  <span className="font-medium">{fmtUsd(stats!.g.theta)}/day</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Vega</span>
                  <span className="font-medium">{fmtUsd(stats!.g.vega)}/pt</span>
                </div>
              </div>
            </div>
          </div>

          <div>
            <SectionTitle
              action={
                <span className="text-[0.7rem] text-muted-foreground">
                  {book!.legs.length} position{book!.legs.length === 1 ? "" : "s"} in the curve
                </span>
              }
            >
              Legs
            </SectionTitle>
            <TableWrap>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Strategy</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Strike</TableHead>
                    <TableHead>Expiration</TableHead>
                    <TableHead className="text-right">Premium</TableHead>
                    <TableHead className="text-right">IV</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {book!.legs.map((l) => (
                    <TableRow key={l.trade.id}>
                      <TableCell className="font-medium">
                        {TRADE_TYPE_LABELS[l.trade.trade_type]}
                        <SourceTag source={l.source} />
                      </TableCell>
                      <TableCell className="text-right tnum">{l.trade.qty}</TableCell>
                      <TableCell className="text-right tnum">{strikeLabel(l.trade)}</TableCell>
                      <TableCell className="tnum">{l.trade.expiration ?? "—"}</TableCell>
                      <TableCell className="text-right tnum">
                        {l.trade.premium == null ? "—" : fmtUsd(Math.abs(l.trade.premium))}
                      </TableCell>
                      <TableCell className="text-right tnum">
                        {l.ivs.length
                          ? `${(l.ivs.reduce((a, b) => a + b, 0) / l.ivs.length * 100).toFixed(1)}%`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right tnum">
                        {fmtUsd(l.entryValue)}
                        {l.basisMissing && (
                          <Badge variant="muted" className="ml-1.5">
                            est
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableWrap>
          </div>
        </>
      )}
    </div>
  );
}
