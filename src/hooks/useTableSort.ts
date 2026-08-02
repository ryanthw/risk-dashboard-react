import { useMemo, useRef, useState } from "react";
import type { SortDir } from "@/components/ui/table";

/** Maps a sort key to the comparable scalar for a row. */
export type SortAccessors<T> = Record<string, (row: T) => number | string | null | undefined>;

interface Options<T> {
  /** Key to sort by on first render. Omit to keep the incoming order. */
  initialKey?: string | null;
  initialDir?: SortDir;
  accessors: SortAccessors<T>;
}

/**
 * Sorting for the data tables. Deliberately not a full table library: the cells
 * here are bespoke JSX, so all that's actually needed is ordering the rows.
 *
 * Nullish values always sort last regardless of direction — a missing figure is
 * absent data, not a small number, and letting it float to the top of an
 * ascending sort would misrepresent it as the best candidate.
 */
export function useTableSort<T>(rows: T[], { initialKey = null, initialDir = "desc", accessors }: Options<T>) {
  const [key, setKey] = useState<string | null>(initialKey);
  const [dir, setDir] = useState<SortDir>(initialDir);

  // Held in a ref so callers can pass an inline object literal without its
  // changing identity re-running the sort on every render. Accessors are pure
  // field lookups in practice, so the latest one is always safe to use.
  const accessorsRef = useRef(accessors);
  accessorsRef.current = accessors;

  const onSort = (next: string) => {
    if (next === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setKey(next);
      // Numeric columns are near-always most-interesting-first.
      setDir("desc");
    }
  };

  const sorted = useMemo(() => {
    const accessor = key ? accessorsRef.current[key] : undefined;
    if (!accessor) return rows;

    const mult = dir === "asc" ? 1 : -1;
    // Slice first — Array.prototype.sort mutates, and `rows` is often a memoised
    // array owned by a parent component.
    return rows.slice().sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);

      const aNull = av === null || av === undefined || (typeof av === "number" && !Number.isFinite(av));
      const bNull = bv === null || bv === undefined || (typeof bv === "number" && !Number.isFinite(bv));
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;

      if (typeof av === "number" && typeof bv === "number") return (av - bv) * mult;
      return String(av).localeCompare(String(bv)) * mult;
    });
  }, [rows, key, dir]);

  return { sorted, sortKey: key, dir, onSort };
}
