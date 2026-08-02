import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, Loader2, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NumberInput } from "@/components/ui/number-input";
import { EmptyState, TableSkeleton } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { isSupabaseConfigured } from "@/lib/supabase";
import { fmtUsd, fmtPct, fmtMultiple } from "@/lib/format";
import { useTradeSandboxStore } from "@/store/tradeSandbox";
import { emptyDraft } from "@/components/trades/TradeFields";
import {
  useIncomeScan,
  useIncomeRescan,
  rankCandidates,
  type DivRating,
  type IncomeCandidate,
} from "@/api/income";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/useTableSort";

/** Ranks the qualitative diversification grade so the column can sort. */
const RATING_ORDER: Record<DivRating, number> = { Poor: 0, Good: 1, Excellent: 2 };

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

  const { sorted, sortKey, dir, onSort } = useTableSort(candidates, {
    initialKey: "annRoc",
    initialDir: "desc",
    accessors: {
      ticker: (c) => c.ticker,
      sector: (c) => c.sector,
      spot: (c) => c.spot,
      strike: (c) => c.strike,
      delta: (c) => c.delta,
      ivHv: (c) => c.ivHv,
      credit: (c) => c.premium,
      annRoc: (c) => c.annRoc,
      collateral: (c) => c.collateral,
      rating: (c) => RATING_ORDER[c.rating] ?? -1,
    },
  });
  const sortProps = { activeKey: sortKey, dir, onSort };

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
        <TableSkeleton rows={8} />
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
        <TableWrap maxHeight={560}>
          <Table>
            <TableHeader>
              <tr>
                <TableHead sortKey="ticker" {...sortProps}>
                  Ticker
                </TableHead>
                <TableHead sortKey="sector" {...sortProps}>
                  Sector
                </TableHead>
                <TableHead right sortKey="spot" {...sortProps}>
                  Spot
                </TableHead>
                <TableHead right sortKey="strike" {...sortProps}>
                  Put / Exp
                </TableHead>
                <TableHead right sortKey="delta" {...sortProps}>
                  Δ
                </TableHead>
                <TableHead right sortKey="ivHv" {...sortProps}>
                  IV / HV
                </TableHead>
                <TableHead right sortKey="credit" {...sortProps}>
                  Credit
                </TableHead>
                <TableHead right sortKey="annRoc" {...sortProps}>
                  Ann. ROC
                </TableHead>
                <TableHead right sortKey="collateral" {...sortProps}>
                  Collateral
                </TableHead>
                <TableHead right sortKey="rating" {...sortProps}>
                  Diversification
                </TableHead>
                <TableHead right>Sandbox</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {sorted.map((c) => (
                <TableRow key={c.ticker}>
                  <TableCell className="font-medium">{c.ticker}</TableCell>
                  <TableCell className="text-muted-foreground">{c.sector}</TableCell>
                  <TableCell right>{fmtUsd(c.spot)}</TableCell>
                  <TableCell right>
                    ${c.strike}
                    <span className="block text-xs text-muted-foreground">
                      {c.expiration} · {c.dte}d
                    </span>
                  </TableCell>
                  <TableCell right>{c.delta.toFixed(2)}</TableCell>
                  <TableCell right>
                    {fmtMultiple(c.ivHv)}
                    <span className="block text-xs text-muted-foreground">
                      {fmtPct(c.iv * 100, 0)} / {fmtPct(c.hv * 100, 0)}
                    </span>
                  </TableCell>
                  <TableCell right className="text-gain">
                    {fmtUsd(c.premium)}
                  </TableCell>
                  <TableCell right className="font-semibold text-gain">
                    {fmtPct(c.annRoc * 100, 1)}
                  </TableCell>
                  <TableCell right className="text-muted-foreground">
                    {fmtUsd(c.collateral, true)}
                  </TableCell>
                  <TableCell right>
                    <Badge
                      variant={
                        c.rating === "Excellent" ? "gain" : c.rating === "Good" ? "muted" : "loss"
                      }
                    >
                      {c.rating}
                    </Badge>
                  </TableCell>
                  <TableCell right>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openInSandbox(c)}
                      title="Open this CSP in the Trade Analysis sandbox"
                    >
                      View <ArrowUpRight className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
