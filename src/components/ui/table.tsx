import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Shared table chrome. The four data tables in this app each hand-rolled their
 * own padding, border opacity, and header casing; these primitives keep them
 * identical and add row hover + sticky headers in one place.
 *
 * Cell *content* stays as bespoke JSX at the call site — these only own layout.
 */

/** Scroll container. Sticky headers only work with the scroller on the wrapper. */
export const TableWrap = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { maxHeight?: number | string }
>(({ className, maxHeight, style, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("relative overflow-auto scrollbar-thin", className)}
    style={{ maxHeight, ...style }}
    {...props}
  />
));
TableWrap.displayName = "TableWrap";

export const Table = React.forwardRef<
  HTMLTableElement,
  React.TableHTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  <table
    ref={ref}
    className={cn("w-full border-separate border-spacing-0 text-sm", className)}
    {...props}
  />
));
Table.displayName = "Table";

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      // Opaque background is required — rows scroll underneath a sticky header.
      "sticky top-0 z-10 bg-card text-left text-[0.7rem] uppercase tracking-wide text-muted-foreground",
      "[&_th]:border-b [&_th]:border-border",
      className,
    )}
    {...props}
  />
));
TableHeader.displayName = "TableHeader";

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child_td]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "transition-colors duration-fast ease-out hover:bg-accent/40",
      "[&_td]:border-b [&_td]:border-border/50",
      className,
    )}
    {...props}
  />
));
TableRow.displayName = "TableRow";

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & { right?: boolean }
>(({ className, right, ...props }, ref) => (
  <td
    ref={ref}
    className={cn("px-3 py-2.5 align-middle", right && "text-right tnum", className)}
    {...props}
  />
));
TableCell.displayName = "TableCell";

export type SortDir = "asc" | "desc";

interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  right?: boolean;
  /** Omit to render a plain, non-interactive header. */
  sortKey?: string;
  activeKey?: string | null;
  dir?: SortDir;
  onSort?: (key: string) => void;
}

export function TableHead({
  className,
  children,
  right,
  sortKey,
  activeKey,
  dir,
  onSort,
  ...props
}: TableHeadProps) {
  const sortable = Boolean(sortKey && onSort);
  const active = sortable && activeKey === sortKey;

  const base = cn("px-3 py-2 font-medium", right && "text-right", className);

  if (!sortable) {
    return (
      <th className={base} {...props}>
        {children}
      </th>
    );
  }

  return (
    <th
      className={cn(base, "p-0")}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      {...props}
    >
      <button
        type="button"
        onClick={() => onSort!(sortKey!)}
        className={cn(
          "group/head flex w-full items-center gap-1 px-3 py-2 text-[0.7rem] uppercase tracking-wide",
          "transition-colors duration-fast ease-out hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          right && "justify-end",
          active && "text-foreground",
        )}
      >
        {children}
        {active ? (
          dir === "asc" ? (
            <ArrowUp className="h-3 w-3 shrink-0" />
          ) : (
            <ArrowDown className="h-3 w-3 shrink-0" />
          )
        ) : (
          // Reserved space keeps headers from reflowing when sort changes.
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/head:opacity-40" />
        )}
      </button>
    </th>
  );
}
