import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface MetricProps {
  label: string;
  value: ReactNode;
  hint?: string;
  delta?: string;
  deltaPositive?: boolean;
  className?: string;
  accent?: "default" | "gain" | "loss" | "primary";
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
}: MetricProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-4 shadow-sm",
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
        {value}
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
