import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { refreshPortfolio } from "@/lib/refreshPortfolio";
import { useAuth } from "@/store/auth";
import type { Portfolio, Trade } from "@/types";
import { toast } from "@/components/ui/toast";

/**
 * Refreshes live prices/IV for every ticker in a portfolio, persists the
 * updates, then records the day's snapshot.
 *
 * The sequence lives in lib/refreshPortfolio so the scheduled job runs exactly
 * the same code. This hook only supplies the client and turns the report into
 * toasts. Unlike the unattended job it still logs a snapshot when some quotes
 * were degraded — someone is watching and can see the warning.
 */
export function useRefreshMarketData(portfolio: Portfolio | undefined, trades: Trade[]) {
  const [refreshing, setRefreshing] = useState(false);
  const qc = useQueryClient();
  const { user } = useAuth();

  const refresh = async () => {
    if (!portfolio || !user) return;
    setRefreshing(true);
    try {
      const report = await refreshPortfolio(supabase, user.id, portfolio, trades);
      await qc.invalidateQueries({ queryKey: ["trades", portfolio.id] });
      await qc.invalidateQueries({ queryKey: ["snapshots", portfolio.id] });

      if (report.rejected.length > 0) {
        const worst = report.rejected[0];
        toast.error(
          `Rejected ${report.rejected.length} quote${report.rejected.length === 1 ? "" : "s"}`,
          `${worst.ticker} quoted ${worst.quoted} vs stored ${worst.stored} — kept the stored price`,
        );
      } else if (report.failed.length > 0) {
        toast.error("Some quotes failed", `${report.failed.join(", ")} kept stale prices`);
      } else {
        const { contract, atmSkew, held, failedGroups } = report.iv;
        const marked = contract + atmSkew;
        const snapNote = report.snapshotLogged
          ? "Snapshot logged"
          : "Snapshot already logged today";

        // The whole IV call going down is the loudest thing that can happen
        // here and the easiest to miss: no marks come back, so a count-based
        // message would render as "0 updated" or, worse, as nothing at all.
        // It gets its own toast rather than a suffix on a success one.
        if (failedGroups.includes("*")) {
          toast.error(
            "IV marks unavailable",
            "position-iv did not respond — every position kept its previous mark",
          );
        } else if (marked + held.length === 0) {
          toast.success("Market data refreshed", snapNote);
        } else {
          // Worth saying out loud: the risk numbers on this page now move with
          // the surface, so which positions did and did not get a fresh mark is
          // part of knowing how much to trust them.
          const ivNote =
            held.length === 0
              ? `${marked} IV mark${marked === 1 ? "" : "s"} updated`
              : `${marked} IV updated, ${held.length} held`;
          toast.success("Market data refreshed", `${snapNote} · ${ivNote}`);
        }
      }
    } catch (e) {
      toast.error("Refresh failed", String((e as Error).message));
    } finally {
      setRefreshing(false);
    }
  };

  return { refresh, refreshing };
}
