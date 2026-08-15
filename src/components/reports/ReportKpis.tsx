import { cn } from "@/lib/cn";

export type KpiTone = "gain" | "loss" | "neutral";

export interface Kpi {
  label: string;
  value: string;
  hint?: string;
  tone?: KpiTone;
}

const TONE_CLASS: Record<KpiTone, string> = {
  gain: "text-[#0f7d5c]",
  loss: "text-[#c24326]",
  neutral: "text-[#1f2933]",
};

/** Sign-driven tone, with an explicit neutral for exactly zero. */
export function toneOf(n: number | null | undefined): KpiTone {
  if (n == null || !Number.isFinite(n) || n === 0) return "neutral";
  return n > 0 ? "gain" : "loss";
}

/**
 * KPI grid for the printed sheet.
 *
 * Four across at 7.5in of usable width gives each tile ~1.8in — enough for a
 * currency figure at this size without wrapping, which is what drove the
 * column count rather than a layout preference.
 */
export function ReportKpis({ items }: { items: Kpi[] }) {
  return (
    <div className="report-block grid grid-cols-4 gap-px bg-[#dfe3e8] ring-1 ring-[#dfe3e8]">
      {items.map((k) => (
        <div key={k.label} className="bg-white px-3 py-2.5">
          <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-[#5a6675]">
            {k.label}
          </p>
          <p
            className={cn(
              "mt-1 text-[19px] font-semibold leading-none tracking-tight tnum",
              TONE_CLASS[k.tone ?? "neutral"],
            )}
          >
            {k.value}
          </p>
          {k.hint && (
            <p className="mt-1 text-[9.5px] leading-snug text-[#7b8794]">{k.hint}</p>
          )}
        </div>
      ))}
    </div>
  );
}
