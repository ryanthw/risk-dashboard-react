import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { fmtNum, fmtPct, fmtUsd } from "@/lib/format";
import { holdDays, type TickerExposure } from "@/engine/reportMetrics";
import type { Position } from "@/engine/portfolio";
import { TRADE_TYPE_LABELS, type HistoryTrade, type TradeType } from "@/types";

/** Ink-on-paper P&L color, matching the report chart palette. */
function pnlInk(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "text-[#1f2933]";
  return n > 0 ? "text-[#0f7d5c]" : "text-[#c24326]";
}

function Th({
  children,
  right,
  className,
}: {
  children: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <th
      className={cn(
        "border-b border-[#c9d0d8] pb-1 pr-2 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#5a6675]",
        right ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  className,
}: {
  children: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "border-b border-[#eceff2] py-1 pr-2 text-[10.5px] text-[#1f2933]",
        right ? "text-right tnum" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}

const strategyLabel = (t: string) => TRADE_TYPE_LABELS[t as TradeType] ?? t;

const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short" })
    : "—";

// ---------------------------------------------------------------------------

/**
 * Every position closed inside the window.
 *
 * Deliberately not truncated to a "top N" — this is the audit trail for the
 * realized figure in the KPI row, and a table that silently drops rows cannot
 * be reconciled against it.
 */
export function ClosedTradesTable({ trades }: { trades: HistoryTrade[] }) {
  const sorted = [...trades].sort(
    (a, b) => new Date(b.exit_date ?? 0).getTime() - new Date(a.exit_date ?? 0).getTime(),
  );
  const total = sorted.reduce((a, t) => a + (t.realized_pnl ?? 0), 0);

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <Th>Ticker</Th>
          <Th>Strategy</Th>
          <Th>Entry</Th>
          <Th>Exit</Th>
          <Th right>Held</Th>
          <Th right>IV @ Close</Th>
          <Th right>P/L</Th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((t) => {
          const held = holdDays(t);
          return (
            <tr key={t.id}>
              <Td className="font-semibold tnum">{t.ticker}</Td>
              <Td>{strategyLabel(t.trade_type)}</Td>
              <Td right>{shortDate(t.entry_date)}</Td>
              <Td right>{shortDate(t.exit_date)}</Td>
              <Td right>{held == null ? "—" : `${Math.round(held)}d`}</Td>
              <Td right>{t.iv_at_close ? fmtPct(t.iv_at_close * 100, 0) : "—"}</Td>
              <Td right className={cn("font-semibold", pnlInk(t.realized_pnl))}>
                {t.realized_pnl == null ? "unbooked" : fmtUsd(t.realized_pnl)}
              </Td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={6} className="pt-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-[#5a6675]">
            Total realized
          </td>
          <td className={cn("pt-1.5 text-right text-[11px] font-semibold tnum", pnlInk(total))}>
            {fmtUsd(total)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

// ---------------------------------------------------------------------------

/** The book as it stands when the report is generated. */
export function OpenPositionsTable({ positions }: { positions: Position[] }) {
  const sorted = [...positions].sort((a, b) => {
    if (a.trade.ticker !== b.trade.ticker) return a.trade.ticker.localeCompare(b.trade.ticker);
    return a.trade.trade_type.localeCompare(b.trade.trade_type);
  });

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <Th>Ticker</Th>
          <Th>Strategy</Th>
          <Th right>Qty</Th>
          <Th right>Strike</Th>
          <Th right>Expiry</Th>
          <Th right>Spot</Th>
          <Th right>Value</Th>
          <Th right>Max Loss</Th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(({ trade, metrics }) => (
          <tr key={trade.id}>
            <Td className="font-semibold tnum">{trade.ticker}</Td>
            <Td>{strategyLabel(trade.trade_type)}</Td>
            <Td right>{trade.qty}</Td>
            <Td right>
              {trade.strike == null
                ? "—"
                : trade.strike_2 == null
                  ? fmtNum(trade.strike, 2)
                  : `${fmtNum(trade.strike, 2)} / ${fmtNum(trade.strike_2, 2)}`}
            </Td>
            <Td right>
              {trade.expiration
                ? new Date(`${trade.expiration}T00:00:00`).toLocaleDateString("en-US", {
                    day: "numeric",
                    month: "short",
                    year: "2-digit",
                  })
                : "—"}
            </Td>
            <Td right>{fmtUsd(trade.underlying_price)}</Td>
            <Td right>{fmtUsd(metrics.value)}</Td>
            <Td right>
              {/* A naked short call has no bounded loss; printing a number
                  there would be the single most misleading cell on the page. */}
              {Number.isFinite(metrics.maxLoss) ? (
                fmtUsd(metrics.maxLoss)
              ) : (
                <span className="font-semibold text-[#c24326]">undefined</span>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------

/** Net exposure per underlying, with the beta restatement beside it. */
export function ExposureTable({
  exposures,
  netLiq,
}: {
  exposures: TickerExposure[];
  netLiq: number;
}) {
  const grossTotal = exposures.reduce((a, e) => a + Math.abs(e.exposure), 0);
  const betaTotal = exposures.reduce((a, e) => a + e.betaWeighted, 0);

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <Th>Ticker</Th>
          <Th right>Legs</Th>
          <Th right>Share Delta</Th>
          <Th right>Exposure</Th>
          <Th right>% of NAV</Th>
          <Th right>Beta</Th>
          <Th right>Beta-Weighted</Th>
        </tr>
      </thead>
      <tbody>
        {exposures.map((e) => (
          <tr key={e.ticker}>
            <Td className="font-semibold tnum">{e.ticker}</Td>
            <Td right>{e.legs}</Td>
            <Td right>{fmtNum(e.shareDelta, 0)}</Td>
            <Td right className={pnlInk(e.exposure)}>
              {fmtUsd(e.exposure)}
            </Td>
            <Td right>{fmtPct(e.pctOfNav, 1)}</Td>
            <Td right>{fmtNum(e.beta, 2)}</Td>
            <Td right>{fmtUsd(e.betaWeighted)}</Td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td
            colSpan={3}
            className="pt-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-[#5a6675]"
          >
            Gross / beta-weighted
          </td>
          <td className="pt-1.5 text-right text-[11px] font-semibold tnum text-[#1f2933]">
            {fmtUsd(grossTotal)}
          </td>
          <td className="pt-1.5 text-right text-[11px] font-semibold tnum text-[#1f2933]">
            {netLiq > 0 ? fmtPct((grossTotal / netLiq) * 100, 0) : "—"}
          </td>
          <td />
          <td className="pt-1.5 text-right text-[11px] font-semibold tnum text-[#1f2933]">
            {fmtUsd(betaTotal)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
