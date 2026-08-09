import { useState } from "react";
import { format } from "date-fns";
import { Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { EditTradeDialog } from "./EditTradeDialog";
import { useArchiveTrade } from "@/api/history";
import { useDeleteTrade } from "@/api/trades";
import { fmtUsd, fmtPct, pnlClass } from "@/lib/format";
import { TRADE_TYPE_LABELS } from "@/types";
import type { Position } from "@/engine/portfolio";
import {
  EXIT_PATH_LABELS,
  availableExitPaths,
  closeIsDebit,
  closingCashFlow,
  realizedPnl,
  sharesDelta,
  type ExitInput,
  type ExitPath,
} from "@/engine/cashFlow";

export function TradeCard({ position }: { position: Position }) {
  const { trade, metrics } = position;
  const [editOpen, setEditOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [path, setPath] = useState<ExitPath>("close");
  // Kept as a raw string so the field can be emptied — parsing on every
  // keystroke turns "" into 0 and makes the placeholder zero undeletable.
  const [amount, setAmount] = useState("");

  const paths = availableExitPaths(trade.trade_type);
  const isDebitClose = closeIsDebit(trade.trade_type);
  const amountNum = Number(amount);
  // Only a plain close needs a number: expiry moves nothing and assignment
  // /call-away are both priced off the strike.
  const needsAmount = path === "close";
  const amountValid =
    !needsAmount || (amount.trim() !== "" && Number.isFinite(amountNum) && amountNum >= 0);

  const exit: ExitInput = { path, amount: amountValid && needsAmount ? amountNum : 0 };
  const derivedPnl = amountValid ? realizedPnl(trade, exit) : null;
  const cashMove = amountValid ? closingCashFlow(trade, exit) : null;
  const stock = sharesDelta(trade, path);

  const archive = useArchiveTrade();
  const del = useDeleteTrade();

  const handleArchive = async () => {
    if (!amountValid) return;
    try {
      const res = await archive.mutateAsync({
        trade,
        exit,
        maxLoss: metrics.maxLoss,
        value: metrics.value,
      });
      toast.success(`Archived ${trade.ticker}`, `${fmtUsd(res.pnl)} realized`);
      setCloseOpen(false);
    } catch (e) {
      toast.error("Archive failed", String((e as Error).message));
    }
  };

  const handleDelete = async () => {
    try {
      await del.mutateAsync({ id: trade.id, portfolioId: trade.portfolio_id });
      toast.success(`Removed ${trade.ticker}`);
      setCloseOpen(false);
    } catch (e) {
      toast.error("Delete failed", String((e as Error).message));
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card/60 p-3.5 transition-[border-color,box-shadow,transform] duration-base ease-out hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{trade.ticker}</span>
            <Badge variant="muted" className="text-[0.65rem]">
              {TRADE_TYPE_LABELS[trade.trade_type]}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {trade.expiration
              ? `Exp ${format(new Date(`${trade.expiration}T00:00:00`), "MMM d, yyyy")} · ${Math.round(metrics.dte)}d`
              : `Qty ${trade.qty}`}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold tnum">{fmtUsd(metrics.value)}</p>
          <p className="text-[0.7rem] text-muted-foreground">Value</p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <p className={`text-sm font-semibold tnum ${pnlClass(metrics.expectedProfit)}`}>
            {fmtUsd(metrics.expectedProfit)}
          </p>
          <p className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            E[P]
          </p>
        </div>
        <div>
          <p className="text-sm font-semibold tnum">{fmtPct(metrics.pop * 100, 1)}</p>
          <p className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            POP
          </p>
        </div>
        <div>
          <p className="text-sm font-semibold tnum text-loss">
            {Number.isFinite(metrics.maxLoss) ? fmtUsd(metrics.maxLoss, true) : "∞"}
          </p>
          <p className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            Max Loss
          </p>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="flex-1"
          onClick={() => setEditOpen(true)}
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
        <Popover
          open={closeOpen}
          onOpenChange={(open) => {
            if (open) {
              setPath("close");
              setAmount("");
            }
            setCloseOpen(open);
          }}
        >
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="flex-1">
              <X className="h-3.5 w-3.5" /> Close
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <p className="text-sm font-semibold">Close {trade.ticker}</p>

            {paths.length > 1 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {paths.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPath(p)}
                    className={
                      path === p
                        ? "rounded-md border border-primary/40 bg-primary/15 px-2 py-1 text-xs font-medium text-primary"
                        : "rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    }
                  >
                    {EXIT_PATH_LABELS[p]}
                  </button>
                ))}
              </div>
            )}

            {needsAmount && (
              <div className="mt-3 space-y-1.5">
                <Label>{isDebitClose ? "Cost to close (debit)" : "Proceeds (credit)"}</Label>
                <Input
                  type="number"
                  step="any"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-invalid={!amountValid}
                />
                <p className="text-[0.7rem] text-muted-foreground">
                  What actually changed hands, as a positive number. P&amp;L is derived.
                </p>
                {!amountValid && (
                  <p className="text-[0.7rem] text-loss">Enter the closing amount.</p>
                )}
              </div>
            )}

            {/* Show the two consequences before committing: what the balance
                does, and what gets booked as the result. */}
            <div className="mt-3 space-y-1 rounded-md border border-border bg-secondary/40 px-2.5 py-2 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Cash</span>
                <span className="tnum font-medium">
                  {cashMove == null
                    ? "—"
                    : cashMove === 0
                      ? "No movement"
                      : `${cashMove > 0 ? "+" : ""}${fmtUsd(cashMove)}`}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Realized P&amp;L</span>
                <span className={`tnum font-semibold ${derivedPnl == null ? "" : pnlClass(derivedPnl)}`}>
                  {derivedPnl == null ? "—" : fmtUsd(derivedPnl)}
                </span>
              </div>
              {stock && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Stock</span>
                  <span className="tnum font-medium">
                    {stock.direction === "acquire" ? "+" : "−"}
                    {stock.shares} sh @ {fmtUsd(stock.basisPerShare)}
                    {stock.direction === "dispose" && (
                      <span className="ml-1 font-normal text-muted-foreground">
                        (P&amp;L to shares)
                      </span>
                    )}
                  </span>
                </div>
              )}
            </div>

            <Button
              variant="success"
              size="sm"
              className="mt-3 w-full"
              onClick={handleArchive}
              disabled={archive.isPending || !amountValid}
            >
              Archive to History
            </Button>
            <div className="my-3 border-t border-border" />
            <Button
              variant="destructive"
              size="sm"
              className="w-full"
              onClick={handleDelete}
              disabled={del.isPending}
            >
              Hard Delete (no history)
            </Button>
          </PopoverContent>
        </Popover>
      </div>

      {editOpen && (
        <EditTradeDialog trade={trade} open={editOpen} onOpenChange={setEditOpen} />
      )}
    </div>
  );
}
