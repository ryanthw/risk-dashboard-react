import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TRADE_TYPES, TRADE_TYPE_LABELS, isSpread, type TradeType } from "@/types";
import { fetchQuote } from "@/api/marketData";
import { todayInput } from "@/lib/dates";
import { isSupabaseConfigured } from "@/lib/supabase";
import { toast } from "@/components/ui/toast";

export interface TradeDraft {
  trade_type: TradeType;
  ticker: string;
  qty: number;
  strike: number;
  strike_2: number;
  premium: number;
  cost_basis: number; // per-share entry price (shares only)
  iv: number;
  expiration: string; // ISO date
  /** Local calendar date the position was opened. */
  opened_at: string;
  underlying_price: number | null;
  sector: string;
  beta: number;
}

export function emptyDraft(): TradeDraft {
  const exp = new Date();
  exp.setDate(exp.getDate() + 30);
  return {
    trade_type: "csp",
    ticker: "",
    qty: 1,
    strike: 0,
    strike_2: 0,
    premium: 0,
    cost_basis: 0,
    iv: 0.3,
    expiration: exp.toISOString().slice(0, 10),
    opened_at: todayInput(),
    underlying_price: null,
    sector: "Unknown",
    beta: 1.0,
  };
}

function NumField({
  label,
  value,
  onChange,
  step = "any",
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <NumberInput value={value} onChange={onChange} step={step} />
    </div>
  );
}

export function TradeFields({
  draft,
  onChange,
  lockType = false,
  showOpenedAt = false,
}: {
  draft: TradeDraft;
  onChange: (d: TradeDraft) => void;
  lockType?: boolean;
  /** Off in the Trade Analysis sandbox, where "execute" always means now. */
  showOpenedAt?: boolean;
}) {
  const [fetching, setFetching] = useState(false);
  const set = (patch: Partial<TradeDraft>) => onChange({ ...draft, ...patch });
  const spread = isSpread(draft.trade_type);

  const handleFetch = async () => {
    if (!draft.ticker) return;
    if (!isSupabaseConfigured) {
      toast.info("Market data unavailable", "Configure Supabase to fetch live quotes.");
      return;
    }
    setFetching(true);
    try {
      const q = await fetchQuote(draft.ticker);
      set({
        underlying_price: q.price,
        sector: q.sector,
        beta: q.beta,
        iv: draft.trade_type === "shares" ? q.hv : draft.iv,
      });
      toast.success(`${q.ticker}: $${q.price.toFixed(2)}`, `IV ${(q.hv * 100).toFixed(1)}% · ${q.sector}`);
    } catch (e) {
      toast.error("Fetch failed", String((e as Error).message));
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Strategy</Label>
        <Select
          value={draft.trade_type}
          onValueChange={(v) => set({ trade_type: v as TradeType })}
          disabled={lockType}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRADE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {TRADE_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>Ticker</Label>
        <div className="flex gap-2">
          <Input
            value={draft.ticker}
            onChange={(e) => set({ ticker: e.target.value.toUpperCase() })}
            placeholder="AAPL"
            className="uppercase"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleFetch}
            disabled={fetching || !draft.ticker}
            title="Fetch live price, IV, sector, beta"
          >
            {fetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
        {draft.underlying_price != null && (
          <p className="text-xs text-muted-foreground tnum">
            Price ${draft.underlying_price.toFixed(2)} · β {draft.beta.toFixed(2)} ·{" "}
            {draft.sector}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <NumField label="Quantity" value={draft.qty} onChange={(n) => set({ qty: n })} step="1" />
        {draft.trade_type === "shares" && (
          <NumField
            label="Cost / share"
            value={draft.cost_basis}
            onChange={(n) => set({ cost_basis: n })}
          />
        )}
        {draft.trade_type !== "shares" && (
          <NumField
            label={spread ? "Strike (Short)" : "Strike"}
            value={draft.strike}
            onChange={(n) => set({ strike: n })}
          />
        )}
        {spread && (
          <NumField
            label="Strike 2 (Long)"
            value={draft.strike_2}
            onChange={(n) => set({ strike_2: n })}
          />
        )}
        {draft.trade_type !== "shares" && (
          <>
            <NumField
              label="Premium / share"
              value={draft.premium}
              onChange={(n) => set({ premium: n })}
            />
            <NumField
              label="Implied Vol (dec)"
              value={draft.iv}
              onChange={(n) => set({ iv: n })}
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {draft.trade_type !== "shares" && (
          <div className="space-y-1.5">
            <Label>Expiration</Label>
            <Input
              type="date"
              value={draft.expiration}
              onChange={(e) => set({ expiration: e.target.value })}
            />
          </div>
        )}
        {showOpenedAt && (
          <div className="space-y-1.5">
            <Label>Opened</Label>
            <Input
              type="date"
              value={draft.opened_at}
              max={todayInput()}
              onChange={(e) => set({ opened_at: e.target.value })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
