/**
 * Calendar-date helpers for `<input type="date">` against timestamptz columns.
 *
 * Both directions go through the *local* calendar deliberately. Slicing an ISO
 * string instead reads the UTC date, which for anyone west of Greenwich shows
 * an evening trade as the day before; and feeding a bare `yyyy-MM-dd` back in
 * parses as UTC midnight, which then shifts it again. Round-tripping in local
 * time is what makes the field show back what was picked.
 */
import { format } from "date-fns";

/** Local calendar date of a timestamp, as the value an `<input type="date">` wants. */
export function toDateInput(iso: string): string {
  return format(new Date(iso), "yyyy-MM-dd");
}

/** Today, in the same form. */
export function todayInput(): string {
  return format(new Date(), "yyyy-MM-dd");
}

/**
 * Move a timestamp onto a picked calendar date, keeping its time of day.
 *
 * Preserving the clock time means re-dating a position does not reshuffle it
 * against others opened the same day, and a date left untouched round-trips to
 * the exact timestamp it started as.
 */
export function withDate(iso: string, dateInput: string): string {
  const [y, m, d] = dateInput.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const base = new Date(iso);
  const moved = new Date(
    y,
    m - 1,
    d,
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    base.getMilliseconds(),
  );
  return moved.toISOString();
}
