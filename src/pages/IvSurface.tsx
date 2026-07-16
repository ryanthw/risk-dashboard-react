import { useMemo, useState } from "react";
import { RefreshCw, Waves } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionTitle, LoadingState, EmptyState } from "@/components/ui/states";
import { useIvSurface, useIvSurfaceRefresh, evalPairs, gradeEdge } from "@/api/ivSurface";
import { TermStructureStrip } from "@/components/ivsurface/TermStructureStrip";
import { IvHeatmap } from "@/components/ivsurface/IvHeatmap";
import { PairDiffChart } from "@/components/ivsurface/PairDiffChart";
import { SuggestionCard } from "@/components/ivsurface/SuggestionCard";

const DELTA_CHOICES = [0.25, 0.3, 0.35, 0.4];

export default function IvSurface() {
  const { data, isLoading, error } = useIvSurface();
  const refresh = useIvSurfaceRefresh();
  const [targetDelta, setTargetDelta] = useState(0.35);
  // Pair the differential view shows; null = follow the suggestion.
  const [pairKey, setPairKey] = useState<string | null>(null);

  const pairs = useMemo(() => evalPairs(data, targetDelta), [data, targetDelta]);
  const best = pairs[0] ?? null;

  const selectedPair = useMemo(() => {
    if (pairKey) {
      const hit = pairs.find((p) => `${p.front}|${p.back}` === pairKey);
      if (hit) return hit;
    }
    return best;
  }, [pairs, pairKey, best]);

  const frontExp = useMemo(
    () => data?.expirations.find((e) => e.expiration === selectedPair?.front) ?? null,
    [data, selectedPair],
  );
  const backExp = useMemo(
    () => data?.expirations.find((e) => e.expiration === selectedPair?.back) ?? null,
    [data, selectedPair],
  );

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Waves className="h-5 w-5 text-primary" /> SPY IV Surface
          </h1>
          <p className="text-xs text-muted-foreground">
            Every listed expiration 5-40 DTE (dailies included) · delta-bucketed live greeks via
            Public · cached 15 min
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data && (
            <span className="text-xs text-muted-foreground tnum">
              SPY ${data.spot.toFixed(2)} · as of{" "}
              {new Date(data.asOf).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              {data.cached && (
                <Badge variant="muted" className="ml-2">
                  cached
                </Badge>
              )}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refresh.isPending ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {isLoading && <LoadingState label="Pulling SPY chains…" />}
      {error && (
        <EmptyState
          title="Surface unavailable"
          hint={error instanceof Error ? error.message : String(error)}
        />
      )}

      {data && (
        <>
          <Card>
            <CardContent className="pt-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <SectionTitle>Suggested Pair — Best Front−Back IV Differential</SectionTitle>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  Short delta
                  <Select
                    value={String(targetDelta)}
                    onValueChange={(v) => {
                      setTargetDelta(Number(v));
                      setPairKey(null);
                    }}
                  >
                    <SelectTrigger className="h-8 w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DELTA_CHOICES.map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {Math.round(d * 100)}Δ
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {best ? (
                <SuggestionCard pair={best} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No expiry pair has all four legs quotable at this delta.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <SectionTitle>Term Structure — ATM IV by Expiration</SectionTitle>
              <p className="mb-2 text-xs text-muted-foreground">
                Band spans 25Δ put→call IV (width = skew). Amber markers are scheduled macro
                prints — a front expiry spiking above its neighbors after a marker is the one to
                sell.
              </p>
              <TermStructureStrip expirations={data.expirations} spot={data.spot} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <SectionTitle>IV Surface — Expiration × Delta</SectionTitle>
              <IvHeatmap expirations={data.expirations} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <SectionTitle>Pair Differential — Front − Back IV by Delta</SectionTitle>
                {pairs.length > 0 && (
                  <Select
                    value={selectedPair ? `${selectedPair.front}|${selectedPair.back}` : ""}
                    onValueChange={setPairKey}
                  >
                    <SelectTrigger className="h-8 w-64">
                      <SelectValue placeholder="Pick an expiry pair" />
                    </SelectTrigger>
                    <SelectContent>
                      {pairs.map((p) => (
                        <SelectItem key={`${p.front}|${p.back}`} value={`${p.front}|${p.back}`}>
                          {p.front.slice(5)} → {p.back.slice(5)} · {p.combinedPts >= 0 ? "+" : ""}
                          {p.combinedPts.toFixed(2)} pt · {gradeEdge(p.combinedPts)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {frontExp && backExp ? (
                <PairDiffChart front={frontExp} back={backExp} />
              ) : (
                <p className="text-sm text-muted-foreground">No pair selected.</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
