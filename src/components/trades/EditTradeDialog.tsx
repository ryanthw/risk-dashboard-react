import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useUpdateTrade } from "@/api/trades";
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

  const [iv, setIv] = useState(trade.iv);
  const [qty, setQty] = useState(trade.qty);
  const [premium, setPremium] = useState(trade.premium ?? 0);
  const [strike, setStrike] = useState(trade.strike ?? 0);
  const [strike2, setStrike2] = useState(trade.strike_2 ?? 0);

  const handleSave = async () => {
    try {
      await update.mutateAsync({
        id: trade.id,
        portfolio_id: trade.portfolio_id,
        iv,
        qty,
        premium: trade.trade_type === "shares" ? null : premium,
        strike: strike > 0 ? strike : null,
        strike_2: spread && strike2 > 0 ? strike2 : null,
      });
      toast.success("Trade updated");
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
          {trade.trade_type !== "shares" && (
            <>
              <div className="space-y-1.5">
                <Label>Premium</Label>
                <NumberInput value={premium} onChange={setPremium} step="any" />
              </div>
              <div className="space-y-1.5">
                <Label>{spread ? "Strike (Short)" : "Strike"}</Label>
                <NumberInput value={strike} onChange={setStrike} step="any" />
              </div>
              {spread && (
                <div className="space-y-1.5">
                  <Label>Strike 2 (Long)</Label>
                  <NumberInput value={strike2} onChange={setStrike2} step="any" />
                </div>
              )}
            </>
          )}
        </div>

        <Button onClick={handleSave} disabled={update.isPending} className="mt-2 w-full">
          Save Changes
        </Button>
      </DialogContent>
    </Dialog>
  );
}
