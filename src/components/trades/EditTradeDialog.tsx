import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useUpdateTrade } from "@/api/trades";
import { openingCashFlow } from "@/engine/cashFlow";
import { toDateInput, todayInput, withDate } from "@/lib/dates";
import { fmtUsd } from "@/lib/format";
import { spreadStrikeLabels } from "./TradeFields";
import { isSpread, type Trade } from "@/types";

export function EditTradeDialog({
  trade,
  open,
  onOpenChange,
}: {
  trade: Trade;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const update = useUpdateTrade();
  const spread = isSpread(trade.trade_type);
  const [strikeLabel, strike2Label] = spreadStrikeLabels(trade.trade_type);

  const [iv, setIv] = useState(trade.iv);
  const [qty, setQty] = useState(trade.qty);
  const [premium, setPremium] = useState(trade.premium ?? 0);
  const [costBasis, setCostBasis] = useState(trade.cost_basis ?? 0);
  const [strike, setStrike] = useState(trade.strike ?? 0);
  const [strike2, setStrike2] = useState(trade.strike_2 ?? 0);
  const [openedAt, setOpenedAt] = useState(toDateInput(trade.opened_at));

  const nextCostBasis =
    trade.trade_type === "shares" && costBasis > 0 ? costBasis : trade.cost_basis;
  const nextPremium = trade.trade_type === "shares" ? null : premium;

  // What the edit does to the cash the entry booked. The existing ledger row is
  // corrected by this amount rather than a reversal being appended — a mis-entry
  // is not an event in the portfolio's life.
  const cashDelta =
    openingCashFlow({ ...trade, qty, premium: nextPremium, cost_basis: nextCostBasis }) -
    openingCashFlow(trade);

  const handleSave = async () => {
    try {
      const { cashDelta: applied } = await update.mutateAsync({
        id: trade.id,
        portfolio_id: trade.portfolio_id,
        previous: trade,
        iv,
        qty,
        premium: nextPremium,
        cost_basis: nextCostBasis,
        strike: strike > 0 ? strike : null,
        strike_2: spread && strike2 > 0 ? strike2 : null,
        opened_at: withDate(trade.opened_at, openedAt),
      });
      toast.success(
        "Trade updated",
        applied === 0 ? undefined : `Cash ${applied > 0 ? "+" : ""}${fmtUsd(applied)}`,
      );
      onOpenChange(false);
    } catch (e) {
      toast.error("Update failed", String((e as Error).message));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update {trade.ticker}</DialogTitle>
          <DialogDescription>
            {trade.trade_type.toUpperCase()} · adjust position parameters
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Quantity</Label>
            <NumberInput value={qty} onChange={setQty} zeroAsEmpty={false} step="1" />
          </div>
          <div className="space-y-1.5">
            <Label>Implied Vol (dec)</Label>
            <NumberInput value={iv} onChange={setIv} step="any" />
          </div>
          {trade.trade_type === "shares" && (
            <div className="space-y-1.5">
              <Label>Cost / share</Label>
              <NumberInput value={costBasis} onChange={setCostBasis} step="any" />
            </div>
          )}
          {trade.trade_type !== "shares" && (
            <>
              <div className="space-y-1.5">
                <Label>Premium</Label>
                <NumberInput value={premium} onChange={setPremium} step="any" />
              </div>
              <div className="space-y-1.5">
                <Label>{spread ? strikeLabel : "Strike"}</Label>
                <NumberInput value={strike} onChange={setStrike} step="any" />
              </div>
              {spread && (
                <div className="space-y-1.5">
                  <Label>{strike2Label}</Label>
                  <NumberInput value={strike2} onChange={setStrike2} step="any" />
                </div>
              )}
            </>
          )}
          <div className="space-y-1.5">
            <Label>Opened</Label>
            <Input
              type="date"
              value={openedAt}
              max={todayInput()}
              onChange={(e) => setOpenedAt(e.target.value)}
            />
          </div>
        </div>

        {cashDelta !== 0 && (
          <div className="mt-1 rounded-md border border-border bg-secondary/40 px-2.5 py-2 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Cash correction</span>
              <span className="tnum font-medium">
                {cashDelta > 0 ? "+" : ""}
                {fmtUsd(cashDelta)}
              </span>
            </div>
            <p className="mt-1 text-[0.7rem] text-muted-foreground">
              Corrects what this entry booked at open — no reversal row, and no
              effect on realized P&amp;L.
            </p>
          </div>
        )}

        <Button onClick={handleSave} disabled={update.isPending} className="mt-2 w-full">
          Save Changes
        </Button>
      </DialogContent>
    </Dialog>
  );
}
