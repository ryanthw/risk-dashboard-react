// Macro-event calendar for the IV term-structure strip. These are the prints
// that put event premium into a specific SPY expiry — the exact thing a
// double-diagonal entry wants to sell.
//
// FOMC/CPI are static published 2026 schedules (decision day / release day) —
// refresh both lists each January. NFP is computed (first Friday; the BLS
// occasionally shifts it, so treat the marker as scheduled, not gospel).

export interface MacroEvent {
  date: string; // ISO
  label: "FOMC" | "CPI" | "NFP";
}

const FOMC_2026 = [
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
];

const CPI_2026 = [
  "2026-01-13", "2026-02-11", "2026-03-11", "2026-04-10",
  "2026-05-12", "2026-06-10", "2026-07-14", "2026-08-12",
  "2026-09-11", "2026-10-13", "2026-11-12", "2026-12-10",
];

function firstFriday(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 1));
  const shift = (5 - d.getUTCDay() + 7) % 7;
  d.setUTCDate(1 + shift);
  return d.toISOString().slice(0, 10);
}

/** All FOMC/CPI/NFP events with fromIso <= date <= toIso (ISO date strings). */
export function macroEventsInWindow(fromIso: string, toIso: string): MacroEvent[] {
  const out: MacroEvent[] = [];
  for (const date of FOMC_2026) out.push({ date, label: "FOMC" });
  for (const date of CPI_2026) out.push({ date, label: "CPI" });

  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) {
    for (let m = 0; m < 12; m++) out.push({ date: firstFriday(y, m), label: "NFP" });
  }

  return out
    .filter((e) => e.date >= fromIso && e.date <= toIso)
    .sort((a, b) => a.date.localeCompare(b.date));
}
