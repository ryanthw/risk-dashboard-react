import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { TradeFields, emptyDraft, type TradeDraft } from "./TradeFields";
import { useUpsertTrade } from "@/api/trades";
import { fetchQuote } from "@/api/marketData";
import { isSupabaseConfigured } from "@/lib/supabase";
import { isSpread, type TradeInput } from "@/types";

function draftToInput(draft: TradeDraft, portfolioId: string): TradeInput {
  const isShares = draft.trade_type === "shares";
  return {
    portfolio_id: portfolioId,
    trade_type: draft.trade_type,
    ticker: draft.ticker.toUpperCase(),
    qty: draft.qty,
    strike: isShares || draft.strike <= 0 ? null : draft.strike,
    strike_2: isSpread(draft.trade_type) && draft.strike_2 > 0 ? draft.strike_2 : null,
    premium: isShares ? null : draft.premium,
    // Basis falls back to the (auto-fetched) live price when not entered.
    cost_basis: isShares
      ? (draft.cost_basis > 0 ? draft.cost_basis : draft.underlying_price)
      : null,
    iv: draft.iv,
    expiration: isShares ? null : draft.expiration,
    underlying_price: draft.underlying_price,
    sector: draft.sector,
    beta: draft.beta,
  };
}

export function AddTradeDialog({
  portfolioId,
  trigger,
}: {
  portfolioId: string;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TradeDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const upsert = useUpsertTrade();

  const handleSave = async () => {
    if (!draft.ticker) {
      toast.error("Ticker required");
      return;
    }
    if (isSpread(draft.trade_type) && draft.strike === draft.strike_2) {
      toast.error("Spread strikes must differ");
      return;
    }
    setSaving(true);
    try {
      // Auto-fetch this ticker's live price/sector/beta (and HV for shares) so
      // the new position has correct metrics immediately — unless the user
      // already pulled or entered a price. Only this trade is fetched.
      let toSave = draft;
      const needsQuote = !draft.underlying_price || draft.underlying_price <= 0;
      if (isSupabaseConfigured && needsQuote) {
        try {
          const q = await fetchQuote(draft.ticker);
          if (q.price > 0) {
            toSave = {
              ...draft,
              underlying_price: q.price,
              sector: q.sector,
              beta: q.beta,
              iv: draft.trade_type === "shares" ? q.hv : draft.iv,
            };
          }
        } catch {
          toast.error(
            "Could not fetch live price",
            "Saving without market data — use Refresh later.",
          );
        }
      }
      await upsert.mutateAsync(draftToInput(toSave, portfolioId));
      toast.success(
        `Added ${toSave.ticker.toUpperCase()}`,
        toSave.underlying_price ? `@ $${toSave.underlying_price.toFixed(2)}` : undefined,
      );
      setDraft(emptyDraft());
      setOpen(false);
    } catch (e) {
      toast.error("Could not save trade", String((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle>Add Trade</DialogTitle>
          <DialogDescription>
            Enter position details. Use the refresh button to pull live price, IV,
            sector and beta.
          </DialogDescription>
        </DialogHeader>
        <TradeFields draft={draft} onChange={setDraft} />
        <Button
          onClick={handleSave}
          disabled={upsert.isPending || saving}
          className="mt-2 w-full"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {saving ? "Fetching price & saving…" : "Save Trade"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
