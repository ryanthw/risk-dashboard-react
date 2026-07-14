import { useMemo } from "react";
import { Layers } from "lucide-react";
import { SectionTitle, LoadingState, NoPortfolio, EmptyState } from "@/components/ui/states";
import { Metric } from "@/components/ui/metric";
import { useActivePortfolio } from "@/hooks/useActivePortfolio";
import { deriveBasisPositions } from "@/engine/basis";
import { fmtPct, fmtUsd } from "@/lib/format";
import { BasisCard } from "@/components/basis/BasisCard";

export default function BasisTracker() {
  const { portfolioId, positions, isLoading } = useActivePortfolio();

  const cards = useMemo(() => deriveBasisPositions(positions), [positions]);

  const totals = useMemo(() => {
    let basis = 0;
    let mark = 0;
    let covered = 0;
    let uncovered = 0;
    for (const c of cards) {
      // Cards with unknown basis are excluded from P/L totals entirely so the
      // aggregate unrealized isn't overstated by mark-only positions.
      if (c.basisTotal == null) continue;
      basis += c.basisTotal;
      mark += c.markTotal;
      if (c.coverage === "covered") covered++;
      if (c.coverage === "uncovered" || c.coverage === "partial") uncovered++;
    }
    const unrealized = mark - basis;
    return {
      basis,
      mark,
      unrealized,
      unrealizedPct: basis > 0 ? (unrealized / basis) * 100 : null,
      covered,
      uncovered,
      ineligible: cards.length - covered - uncovered,
    };
  }, [cards]);

  if (!portfolioId) return <NoPortfolio />;
  if (isLoading) return <LoadingState />;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <SectionTitle>Basis Tracker</SectionTitle>
        <p className="mb-4 text-xs text-muted-foreground">
          Share lots and stock-replacement long calls (&gt;3 months out, Δ &gt; 0.5), with
          cost basis, unrealized P/L, covered-call coverage, the IV term structure
          across upcoming expirations, and a technical risk grade. Marks for LEAPS use
          the live option mid when available, else a Black-Scholes value from stored IV.
        </p>
      </div>

      {cards.length === 0 ? (
        <EmptyState
          icon={<Layers className="h-8 w-8" />}
          title="No basis positions"
          hint="Add a Long Equity position or a long-dated (>3M, Δ>0.5) Long Call and it will show up here."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Total Basis" value={fmtUsd(totals.basis, true)} />
            <Metric label="Market Value" value={fmtUsd(totals.mark, true)} />
            <Metric
              label="Unrealized"
              value={fmtUsd(totals.unrealized, true)}
              delta={totals.unrealizedPct != null ? fmtPct(totals.unrealizedPct) : undefined}
              deltaPositive={totals.unrealized >= 0}
              accent={totals.unrealized >= 0 ? "gain" : "loss"}
            />
            <Metric
              label="Coverage"
              value={`${totals.covered}/${totals.covered + totals.uncovered}`}
              hint={`covered · ${totals.ineligible} ineligible`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {cards.map((c) => (
              <BasisCard key={c.trade.id} pos={c} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
