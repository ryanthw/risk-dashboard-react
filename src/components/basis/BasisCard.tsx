import { useMemo, useState } from "react";
import { CalendarClock, Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { fmtPct, fmtUsd, pnlClass } from "@/lib/format";
import { TRADE_TYPE_LABELS } from "@/types";
import type { BasisPosition, CoverageStatus } from "@/engine/basis";
import { riskGrade, type GradeLetter } from "@/engine/riskGrade";
import { useDailyCloses, useVolSurface, type ContractRef } from "@/api/basis";
import { VolTermChart } from "./VolTermChart";

const COVERAGE_LABEL: Record<CoverageStatus, string> = {
  covered: "Covered",
  partial: "Partially covered",
  uncovered: "Uncovered",
  ineligible: "Ineligible",
};

function CoverageBadge({ pos }: { pos: BasisPosition }) {
  const { coverage, ccAllocated, lots } = pos;
  const variant =
    coverage === "covered" ? "gain" : coverage === "ineligible" ? "muted" : "loss";
  const detail =
    coverage === "partial"
      ? ` ${ccAllocated}/${lots}`
      : coverage === "ineligible"
        ? " (<100 sh)"
        : "";
  return (
    <Badge variant={variant}>
      {COVERAGE_LABEL[coverage]}
      {detail}
    </Badge>
  );
}

const GRADE_CLASS: Record<GradeLetter, string> = {
  A: "bg-gain/15 text-gain",
  B: "bg-gain/10 text-gain",
  C: "bg-amber-500/15 text-amber-500",
  D: "bg-loss/10 text-loss",
  F: "bg-loss/15 text-loss",
};

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tnum", valueClass)}>{value}</span>
    </div>
  );
}

export function BasisCard({ pos }: { pos: BasisPosition }) {
  const { trade } = pos;
  const [factorsOpen, setFactorsOpen] = useState(false);

  // LEAPS cards ask the vol surface to quote their exact contract too.
  const contracts: ContractRef[] = useMemo(
    () =>
      pos.kind === "long_call" && trade.expiration && trade.strike
        ? [{ expiration: trade.expiration, strike: trade.strike, cp: "C" as const }]
        : [],
    [pos.kind, trade.expiration, trade.strike],
  );
  const vol = useVolSurface(trade.ticker, contracts);
  const closes = useDailyCloses(trade.ticker);

  const spot = vol.data?.spot || trade.underlying_price || 0;
  const grade = useMemo(
    () => (closes.data && spot > 0 ? riskGrade(closes.data, spot) : null),
    [closes.data, spot],
  );

  // Prefer the live option mid over the BSM mark when the surface returned it.
  //
  // Matching the option type is not optional. vol-surface caches per ticker and
  // returns every contract in that cache, not just the ones this card asked
  // for, so once another tab quotes a PUT at the same expiration and strike --
  // Position Analysis does exactly that -- an expiration+strike match returns
  // it first. This is a long-call card: it would then mark a LEAPS at the put's
  // mid and report the put's negative delta. A pre-`cp` cache entry matches
  // nothing here and falls back to the BSM mark, which is the safe direction.
  const liveQuote = vol.data?.contracts.find(
    (c) => c.cp === "C" && c.expiration === trade.expiration && c.strike === trade.strike,
  );
  const markTotal =
    pos.kind === "long_call" && liveQuote && liveQuote.mid > 0
      ? liveQuote.mid * 100 * trade.qty
      : pos.markTotal;
  const unrealized = pos.basisTotal != null ? markTotal - pos.basisTotal : null;
  const unrealizedPct =
    unrealized != null && pos.basisTotal ? (unrealized / pos.basisTotal) * 100 : null;
  const annualized =
    unrealizedPct != null && pos.daysHeld >= 7
      ? unrealizedPct * (365 / pos.daysHeld)
      : null;
  const delta = pos.kind === "long_call" ? (liveQuote?.delta ?? pos.delta) : null;

  const earnings = vol.data?.earnings ?? null;
  const cc = vol.data?.ccCandidate ?? null;
  const showCcSuggestion =
    (pos.coverage === "uncovered" || pos.coverage === "partial") && cc != null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{trade.ticker}</CardTitle>
          <Badge variant="outline">
            {pos.kind === "shares" ? TRADE_TYPE_LABELS.shares : "Long Call (LEAPS)"}
          </Badge>
          <CoverageBadge pos={pos} />
          {grade && (
            <span
              className={cn(
                "ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-sm font-bold",
                GRADE_CLASS[grade.grade],
              )}
              title={`Risk grade ${grade.grade} · ${grade.score}/100`}
            >
              {grade.grade}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground tnum">
          {pos.kind === "shares"
            ? `${trade.qty} shares · ${pos.daysHeld}d held`
            : `${trade.qty} × $${trade.strike?.toFixed(2)} call · exp ${trade.expiration} (${Math.round(pos.dte ?? 0)}d)` +
              (delta != null ? ` · Δ ${delta.toFixed(2)}` : "") +
              ` · ${pos.daysHeld}d held`}
          {earnings && (
            <span className="ml-2 inline-flex items-center gap-1 text-amber-500">
              <CalendarClock className="h-3 w-3" /> earnings {earnings}
            </span>
          )}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Row
            label={pos.kind === "shares" ? "Cost basis" : "Basis (premium paid)"}
            value={
              pos.basisTotal != null
                ? `${fmtUsd(pos.basisTotal)} (${fmtUsd(pos.basisPerShare)}/sh)`
                : "— set via Edit Trade"
            }
          />
          <Row label="Market value" value={fmtUsd(markTotal)} />
          <Row
            label="Unrealized"
            value={
              unrealized != null
                ? `${fmtUsd(unrealized)} (${fmtPct(unrealizedPct)})`
                : "—"
            }
            valueClass={unrealized != null ? pnlClass(unrealized) : undefined}
          />
          {annualized != null && (
            <Row
              label="Annualized"
              value={fmtPct(annualized, 1)}
              valueClass={pnlClass(annualized)}
            />
          )}
          {pos.kind === "long_call" && (
            <Row
              label="Breakeven at expiry"
              value={`${fmtUsd(pos.breakeven)}${spot > 0 && pos.breakeven ? ` (spot ${fmtUsd(spot)})` : ""}`}
            />
          )}
        </div>

        {showCcSuggestion && (
          <div className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
            <span className="font-medium text-primary">Cover it: </span>
            sell the {cc.expiration} ${cc.strike.toFixed(2)} call ({cc.dte}d, Δ{" "}
            {cc.delta.toFixed(2)}) for ~{fmtUsd(cc.mid)}/sh ·{" "}
            {fmtPct(cc.annYield * 100, 1)} annualized on spot
          </div>
        )}

        <div>
          {vol.isLoading ? (
            <div className="flex h-[190px] animate-pulse items-center justify-center rounded-lg bg-muted/30 text-xs text-muted-foreground">
              Loading vol surface…
            </div>
          ) : vol.data?.expirations.length ? (
            <>
              <VolTermChart expirations={vol.data.expirations} spot={spot} />
              <p className="mt-1 text-[0.7rem] text-muted-foreground">
                ATM IV by expiration · source:{" "}
                {vol.data.source === "public" ? "Public (live)" : "DoltHub (delayed)"}
              </p>
            </>
          ) : (
            <p className="rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              No vol data available{vol.error ? ` — ${String((vol.error as Error).message)}` : ""}.
            </p>
          )}
        </div>

        {grade && (
          <div>
            <button
              onClick={() => setFactorsOpen((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Risk grade {grade.grade} · {grade.score}/100
              {factorsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {factorsOpen && (
              <ul className="mt-2 space-y-1">
                {grade.factors.map((f) => (
                  <li key={f.label} className="flex items-center gap-2 text-xs">
                    {f.ok ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-gain" />
                    ) : (
                      <X className="h-3.5 w-3.5 shrink-0 text-loss" />
                    )}
                    <span>{f.label}</span>
                    <span className="ml-auto text-muted-foreground tnum">{f.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
