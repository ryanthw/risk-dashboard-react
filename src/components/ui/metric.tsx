import type { ReactNode } from "react";
import NumberFlow, { type Format } from "@number-flow/react";
import { cn } from "@/lib/cn";

interface MetricProps {
  label: string;
  value: ReactNode;
  hint?: string;
  delta?: string;
  deltaPositive?: boolean;
  className?: string;
  accent?: "default" | "gain" | "loss" | "primary";
  /**
   * Raw number behind `value`. When supplied the tile animates between values
   * on refresh instead of snapping, which makes it obvious *which* figures
   * actually moved. `value` is still the fallback for null/non-finite input.
   */
  animate?: number | null;
  /** Intl options for the animated readout — should match `value`'s format. */
  format?: Format;
}

/** Compact KPI tile used across the dashboard. */
export function Metric({
  label,
  value,
  hint,
  delta,
  deltaPositive,
  className,
  accent = "default",
  animate,
  format,
}: MetricProps) {
  const canAnimate = animate != null && Number.isFinite(animate);
  return (
    <div
      className={cn(
        "group rounded-lg border border-border bg-card p-4 shadow-sm",
        "transition-[border-color,box-shadow,transform] duration-base ease-out",
        "hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lg",
        className,
      )}
    >
      <p className="text-[0.7rem] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tnum tracking-tight",
          accent === "gain" && "text-gain",
          accent === "loss" && "text-loss",
          accent === "primary" && "text-primary",
        )}
      >
        {canAnimate ? <NumberFlow value={animate} format={format} /> : value}
      </p>
      {(hint || delta) && (
        <div className="mt-1 flex items-center gap-2">
          {delta && (
            <span
              className={cn(
                "text-xs font-medium tnum",
                deltaPositive ? "text-gain" : "text-loss",
              )}
            >
              {delta}
            </span>
          )}
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </div>
      )}
    </div>
  );
}

interface StatRowProps {
  label: string;
  value: ReactNode;
  tone?: "info" | "gain" | "loss" | "muted";
}

/** A labeled value row (replaces Streamlit's st.info/st.success boxes). */
export function StatRow({ label, value, tone = "info" }: StatRowProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
        tone === "info" && "border-border bg-secondary/40",
        tone === "gain" && "border-gain/30 bg-gain/10",
        tone === "loss" && "border-loss/30 bg-loss/10",
        tone === "muted" && "border-border bg-muted/30",
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-semibold tnum",
          tone === "gain" && "text-gain",
          tone === "loss" && "text-loss",
        )}
      >
        {value}
      </span>
    </div>
  );
}
