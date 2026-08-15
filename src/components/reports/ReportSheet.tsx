import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The printable page.
 *
 * Everything inside renders on paper — light ground, ink text, its own type
 * scale — regardless of the app's dark theme. Styling here is deliberately
 * plain CSS rather than Tailwind's semantic tokens (`bg-card`, `text-muted-
 * foreground`), because those resolve to the dark palette and would print as
 * near-black rectangles.
 */
export function ReportSheet({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "report-sheet rounded-lg shadow-lg ring-1 ring-black/10",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface HeaderProps {
  portfolioName: string;
  periodLabel: string;
  /** Rendered range, e.g. "12 Jun 2026 – 14 Aug 2026". */
  range: string;
  generatedAt: Date;
}

export function ReportHeader({
  portfolioName,
  periodLabel,
  range,
  generatedAt,
}: HeaderProps) {
  return (
    <header className="report-block mb-6 border-b-2 border-[#1f2933] pb-4">
      <div className="flex items-start justify-between gap-6">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5a6675]">
            Performance Report · {periodLabel}
          </p>
          <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight text-[#1f2933]">
            {portfolioName}
          </h1>
          <p className="mt-1 text-[12px] text-[#5a6675] tnum">{range}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5a6675]">
            Generated
          </p>
          <p className="mt-1 text-[12px] text-[#1f2933] tnum">
            {generatedAt.toLocaleDateString("en-US", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </p>
          <p className="text-[11px] text-[#5a6675] tnum">
            {generatedAt.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
            })}
          </p>
        </div>
      </div>
    </header>
  );
}

/** Section heading inside the sheet. */
export function ReportSection({
  title,
  hint,
  children,
  breakBefore = false,
  avoidBreak = true,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  /**
   * Forces a fresh page. Used sparingly — a forced break ahead of a section
   * that would have fit anyway pushes whatever precedes it onto a page of its
   * own and leaves half a sheet blank. Only the closed-trade ledger, which is
   * long and belongs on its own page, sets it.
   */
  breakBefore?: boolean;
  /** Tables that legitimately run long should pass false and flow across pages. */
  avoidBreak?: boolean;
}) {
  return (
    <section
      className={cn(
        "mt-6",
        breakBefore && "report-page-break",
        avoidBreak && "report-block",
      )}
    >
      <div className="mb-2 flex items-baseline justify-between gap-4 border-b border-[#dfe3e8] pb-1.5">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.09em] text-[#1f2933]">
          {title}
        </h2>
        {hint && <p className="text-[10.5px] text-[#5a6675]">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** Footnote row — the caveats that keep a number from being over-read. */
export function ReportFootnote({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[10px] leading-relaxed text-[#7b8794]">{children}</p>;
}
