import { Badge } from "@/components/ui/badge";
import { StatRow } from "@/components/ui/metric";
import { gradeEdge } from "@/api/ivSurface";
import type { PairEval } from "@/api/ivSurface";

const GRADE_VARIANT = { Actionable: "gain", Marginal: "default", "No edge": "muted" } as const;

const GRADE_HINT: Record<string, string> = {
  Actionable:
    "Front expiry is meaningfully richer than the back — the structure's engine is present.",
  Marginal:
    "Some front-month premium, but thin. The trade mostly rides realized vol staying under IV.",
  "No edge":
    "Term structure is flat-to-contango at these deltas. A double diagonal entered here is a coin flip minus costs — wait for an event bump.",
};

/**
 * The generated suggestion: best front/back IV differential across every
 * displayed expiry pair, expressed as the four-leg double diagonal it implies.
 */
export function SuggestionCard({ pair }: { pair: PairEval }) {
  const grade = gradeEdge(pair.combinedPts);
  const sells = pair.legs.filter((l) => l.action === "SELL");
  const buys = pair.legs.filter((l) => l.action === "BUY");
  const legLine = (legs: typeof pair.legs) =>
    legs
      .map((l) => `$${l.strike}${l.side} ${l.expiration.slice(5)} (Δ${Math.abs(l.delta).toFixed(2)})`)
      .join("  ·  ");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={GRADE_VARIANT[grade]}>{grade}</Badge>
        <span className="text-sm font-semibold tnum">
          {pair.combinedPts >= 0 ? "+" : ""}
          {pair.combinedPts.toFixed(2)} pt front−back IV
        </span>
        <span className="text-xs text-muted-foreground">
          {pair.front} ({pair.frontDte}d) short → {pair.back} ({pair.backDte}d) long
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <StatRow label="SELL (front)" value={legLine(sells)} tone="loss" />
        <StatRow label="BUY (back)" value={legLine(buys)} tone="gain" />
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <StatRow label="Est. debit (mid)" value={`$${(pair.debit * 100).toFixed(0)}`} tone="muted" />
        <StatRow
          label="Put / call diff"
          value={`${pair.putDiffPts.toFixed(2)} / ${pair.callDiffPts.toFixed(2)} pt`}
          tone="muted"
        />
        <StatRow label="Net vega" value={`$${(pair.netVega * 100).toFixed(0)}/pt`} tone="muted" />
        <StatRow label="Net theta" value={`$${(pair.netTheta * 100).toFixed(0)}/day`} tone="muted" />
      </div>

      <p className="text-xs text-muted-foreground">{GRADE_HINT[grade]}</p>
    </div>
  );
}
