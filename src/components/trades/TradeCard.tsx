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

export function TradeCard({ position }: { position: Position }) {
  const { trade, metrics } = position;
  const [editOpen, setEditOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  // Kept as a raw string so the field can be emptied — parsing on every
  // keystroke turns "" into 0 and makes the placeholder zero undeletable.
  const [realized, setRealized] = useState(String(metrics.expectedProfit));

  const realizedNum = Number(realized);
  const realizedValid = realized.trim() !== "" && Number.isFinite(realizedNum);

  const archive = useArchiveTrade();
  const del = useDeleteTrade();

  const handleArchive = async () => {
    if (!realizedValid) return;
    try {
      await archive.mutateAsync({
        trade,
        realizedPnl: realizedNum,
        maxLoss: metrics.maxLoss,
        value: metrics.value,
      });
      toast.success(`Archived ${trade.ticker}`, `${fmtUsd(realizedNum)} realized`);
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
            if (open) setRealized(String(metrics.expectedProfit));
            setCloseOpen(open);
          }}
        >
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="flex-1">
              <X className="h-3.5 w-3.5" /> Close
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <p className="text-sm font-semibold">Close {trade.ticker}</p>
            <div className="mt-3 space-y-1.5">
              <Label>Final realized P&L</Label>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                placeholder="0.00"
                value={realized}
                onChange={(e) => setRealized(e.target.value)}
                aria-invalid={!realizedValid}
              />
              {!realizedValid && (
                <p className="text-[0.7rem] text-loss">Enter a realized P&L to archive.</p>
              )}
            </div>
            <Button
              variant="success"
              size="sm"
              className="mt-3 w-full"
              onClick={handleArchive}
              disabled={archive.isPending || !realizedValid}
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
