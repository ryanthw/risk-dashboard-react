import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, Loader2, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NumberInput } from "@/components/ui/number-input";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { isSupabaseConfigured } from "@/lib/supabase";
import { fmtUsd, fmtPct, fmtMultiple } from "@/lib/format";
import { useTradeSandboxStore } from "@/store/tradeSandbox";
import { emptyDraft } from "@/components/trades/TradeFields";
import {
  useIncomeScan,
  useIncomeRescan,
  rankCandidates,
  type IncomeCandidate,
} from "@/api/income";

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-9 w-full accent-primary"
      />
    </div>
  );
}

/** Cash-secured-put income scanner driven by the cached income-scanner payload. */
export function IncomeScannerPanel({
  sectorWeights,
}: {
  sectorWeights: Record<string, number>;
}) {
  const navigate = useNavigate();
  const setDraft = useTradeSandboxStore((s) => s.setDraft);

  const [maxPrice, setMaxPrice] = useState(15);
  const [targetDelta, setTargetDelta] = useState(0.3);
  const [targetDte, setTargetDte] = useState(45);

  const scan = useIncomeScan();
  const rescan = useIncomeRescan();

  const candidates = useMemo(
    () => rankCandidates(scan.data, { maxPrice, targetDelta, targetDte, sectorWeights }),
    [scan.data, maxPrice, targetDelta, targetDte, sectorWeights],
  );

  const refresh = () => {
    if (!isSupabaseConfigured) {
      toast.info("Market data not configured");
      return;
    }
    rescan.mutate(undefined, {
      onSuccess: (d) => toast.success("Scan refreshed", `${d.count} names from the live chain.`),
      onError: (e) => toast.error("Refresh failed", String((e as Error).message)),
    });
  };

  const openInSandbox = (c: IncomeCandidate) => {
    setDraft({
      ...emptyDraft(),
      trade_type: "csp",
      ticker: c.ticker,
      qty: 1,
      strike: c.strike,
      strike_2: 0,
      premium: +c.credit.toFixed(2),
      iv: +c.iv.toFixed(4),
      expiration: c.expiration,
      underlying_price: c.spot,
      sector: c.sector,
      beta: c.beta,
    });
    navigate("/analysis");
  };

  const freshness = (() => {
    if (!scan.data?.generatedAt) return null;
    const mins = Math.round((Date.now() - new Date(scan.data.generatedAt).getTime()) / 60000);
    return mins <= 0 ? "just now" : `${mins} min ago`;
  })();

  return (
    <div className="space-y-4">
      <div className="grid items-end gap-4 sm:grid-cols-[140px_1fr_1fr_auto]">
        <div className="space-y-1.5">
          <Label>Max Share Price ($)</Label>
          <NumberInput value={maxPrice} onChange={setMaxPrice} step="1" />
        </div>
        <Slider
          label={`Target Delta (${targetDelta.toFixed(2)})`}
          value={targetDelta}
          min={0.1}
          max={0.4}
          step={0.01}
          onChange={setTargetDelta}
        />
        <Slider
          label={`Target DTE (${targetDte}d)`}
          value={targetDte}
          min={7}
          max={60}
          step={1}
          onChange={setTargetDte}
        />
        <Button onClick={refresh} disabled={rescan.isPending} variant="outline">
          {rescan.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      {freshness && (
        <p className="text-xs text-muted-foreground">
          Chain data ~15 min delayed · updated {freshness} · showing top {candidates.length}
        </p>
      )}

      {scan.isLoading ? (
        <LoadingState label="Loading option chains…" />
      ) : scan.isError ? (
        <EmptyState
          title="Scan unavailable"
          hint={String((scan.error as Error)?.message ?? "Could not load the income scan.")}
        />
      ) : candidates.length === 0 ? (
        <EmptyState
          title="No candidates match"
          hint="Loosen the price cap or delta/DTE targets, or refresh the chain."
        />
      ) : (
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-4">Ticker</th>
                <th className="py-2 pr-4">Sector</th>
                <th className="py-2 pr-4 text-right">Spot</th>
                <th className="py-2 pr-4 text-right">Put / Exp</th>
                <th className="py-2 pr-4 text-right">Δ</th>
                <th className="py-2 pr-4 text-right">IV / HV</th>
                <th className="py-2 pr-4 text-right">Credit</th>
                <th className="py-2 pr-4 text-right">Ann. ROC</th>
                <th className="py-2 pr-4 text-right">Collateral</th>
                <th className="py-2 pr-4 text-right">Diversification</th>
                <th className="py-2 text-right">Sandbox</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.ticker} className="border-b border-border/40 last:border-0">
                  <td className="py-2 pr-4 font-medium">{c.ticker}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{c.sector}</td>
                  <td className="py-2 pr-4 text-right tnum">{fmtUsd(c.spot)}</td>
                  <td className="py-2 pr-4 text-right tnum">
                    ${c.strike}
                    <span className="block text-xs text-muted-foreground">
                      {c.expiration} · {c.dte}d
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-right tnum">{c.delta.toFixed(2)}</td>
                  <td className="py-2 pr-4 text-right tnum">
                    {fmtMultiple(c.ivHv)}
                    <span className="block text-xs text-muted-foreground">
                      {fmtPct(c.iv * 100, 0)} / {fmtPct(c.hv * 100, 0)}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-right tnum text-gain">{fmtUsd(c.premium)}</td>
                  <td className="py-2 pr-4 text-right tnum font-semibold text-gain">
                    {fmtPct(c.annRoc * 100, 1)}
                  </td>
                  <td className="py-2 pr-4 text-right tnum text-muted-foreground">
                    {fmtUsd(c.collateral, true)}
                  </td>
                  <td className="py-2 pr-4 text-right">
                    <Badge
                      variant={
                        c.rating === "Excellent" ? "gain" : c.rating === "Good" ? "muted" : "loss"
                      }
                    >
                      {c.rating}
                    </Badge>
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openInSandbox(c)}
                      title="Open this CSP in the Trade Analysis sandbox"
                    >
                      View <ArrowUpRight className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
