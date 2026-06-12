import { useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { fetchQuote } from "@/api/marketData";
import { isSupabaseConfigured } from "@/lib/supabase";
import { toast } from "@/components/ui/toast";
import { EmptyState } from "@/components/ui/states";

const DEFAULT_WATCHLIST =
  "AMD, F, BAC, KO, TGT, XOM, PFE, INTC, PLTR, SOFI, CCL, AAL, VALE";
const TARGET_DTE = 45;

interface ScanResult {
  ticker: string;
  sector: string;
  price: number;
  iv: number;
  strike: number;
  rating: "Good" | "Neutral" | "Poor";
  score: number;
}

/** Wheel-strategy opportunity scanner — ranks a watchlist by IV × diversification. */
export function OpportunityScanner({
  sectorWeights,
}: {
  sectorWeights: Record<string, number>;
}) {
  const [watchlist, setWatchlist] = useState(DEFAULT_WATCHLIST);
  const [maxPrice, setMaxPrice] = useState(100);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<ScanResult[] | null>(null);

  const runScan = async () => {
    if (!isSupabaseConfigured) {
      toast.info("Market data not configured");
      return;
    }
    const tickers = [
      ...new Set(
        watchlist
          .split(",")
          .map((t) => t.trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    if (tickers.length === 0) return;

    setScanning(true);
    try {
      const out: ScanResult[] = [];
      await Promise.all(
        tickers.map(async (ticker) => {
          try {
            const q = await fetchQuote(ticker);
            if (q.price <= 0 || q.price > maxPrice) return;
            const currentWeight = sectorWeights[q.sector] ?? 0;
            const divScore = 1 - currentWeight;
            const stdMove = q.hv * Math.sqrt(TARGET_DTE / 365);
            let strike = q.price * (1 - 0.5 * stdMove);
            strike = strike > 20 ? Math.round(strike) : Math.round(strike * 2) / 2;
            out.push({
              ticker,
              sector: q.sector,
              price: q.price,
              iv: q.hv,
              strike,
              rating: currentWeight < 0.05 ? "Good" : currentWeight < 0.15 ? "Neutral" : "Poor",
              score: q.hv * divScore,
            });
          } catch {
            /* skip ticker */
          }
        }),
      );
      out.sort((a, b) => b.score - a.score);
      setResults(out);
      if (out.length === 0) toast.info("No matches", "No tickers met the price criteria.");
    } catch (e) {
      toast.error("Scan failed", String((e as Error).message));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <div className="space-y-1.5">
          <Label>Watchlist (comma separated)</Label>
          <Input value={watchlist} onChange={(e) => setWatchlist(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Max Share Price (${maxPrice})</Label>
          <input
            type="range"
            min={10}
            max={500}
            step={5}
            value={maxPrice}
            onChange={(e) => setMaxPrice(Number(e.target.value))}
            className="h-9 w-full accent-primary"
          />
        </div>
      </div>
      <Button onClick={runScan} disabled={scanning} className="w-full sm:w-auto">
        {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        Run Opportunity Scan
      </Button>

      {results &&
        (results.length > 0 ? (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-4">Ticker</th>
                  <th className="py-2 pr-4">Sector</th>
                  <th className="py-2 pr-4 text-right">Price</th>
                  <th className="py-2 pr-4 text-right">IV (30d)</th>
                  <th className="py-2 pr-4 text-right">Sugg. Strike</th>
                  <th className="py-2 text-right">Diversification</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.ticker} className="border-b border-border/40 last:border-0">
                    <td className="py-2 pr-4 font-medium">{r.ticker}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{r.sector}</td>
                    <td className="py-2 pr-4 text-right tnum">${r.price.toFixed(2)}</td>
                    <td className="py-2 pr-4 text-right tnum">{(r.iv * 100).toFixed(1)}%</td>
                    <td className="py-2 pr-4 text-right tnum">${r.strike}</td>
                    <td className="py-2 text-right">
                      <Badge
                        variant={
                          r.rating === "Good" ? "gain" : r.rating === "Neutral" ? "muted" : "loss"
                        }
                      >
                        {r.rating}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No opportunities found" hint="Try raising the max price or adding tickers." />
        ))}
    </div>
  );
}
