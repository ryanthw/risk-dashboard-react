/**
 * Cash-flow math for opening and closing positions.
 *
 * The rule that drives the whole module: **realized P&L is a result, not a
 * transaction.** Cash moves by the amount that actually changed hands at open
 * and again at close. Booking the exit against realized P&L instead would
 * double-count the opening premium — collect $20 on a CSP, buy it back for $5,
 * and the balance must land at $15, not $35.
 *
 * So closing amounts are captured from the broker confirmation and P&L is
 * derived from the pair.
 */
import { CREDIT_TYPES, type CashFlowKind, type Trade, type TradeType } from "@/types";

/**
 * Flows that change the capital base rather than the portfolio earning or
 * losing its own money. Only these break the chain in a time-weighted return —
 * everything else is performance and must stay inside it.
 */
const EXTERNAL_KINDS = new Set<CashFlowKind>(["opening_balance", "deposit", "withdrawal"]);

export function isExternal(kind: CashFlowKind): boolean {
  return EXTERNAL_KINDS.has(kind);
}

/** Shares trade 1:1; every option type is 100 shares per contract. */
export function contractMultiplier(t: TradeType): number {
  return t === "shares" ? 1 : 100;
}

const isCredit = (t: TradeType) => CREDIT_TYPES.includes(t);

/**
 * Signed cash at entry: positive is a credit received, negative a debit paid.
 * Shares are bought at cost basis (falling back to the mark when basis is
 * missing); credit structures pay you the premium; debit structures cost it.
 */
export function openingCashFlow(trade: Trade): number {
  const t = trade.trade_type;
  if (t === "shares") {
    const perShare = trade.cost_basis ?? trade.underlying_price ?? 0;
    return -perShare * trade.qty;
  }
  const gross = Math.abs(trade.premium ?? 0) * 100 * trade.qty;
  return isCredit(t) ? gross : -gross;
}

export type ExitPath = "close" | "expired" | "assigned" | "called_away";

export const EXIT_PATH_LABELS: Record<ExitPath, string> = {
  close: "Closed",
  expired: "Expired worthless",
  assigned: "Assigned",
  called_away: "Called away",
};

/** Which exits are reachable for a given structure. */
export function availableExitPaths(t: TradeType): ExitPath[] {
  if (t === "shares") return ["close"];
  if (t === "csp" || t === "short_put") return ["close", "expired", "assigned"];
  if (t === "cc" || t === "short_call") return ["close", "expired", "called_away"];
  // Spreads can be assigned on the short leg, but the outcome depends on what
  // happens to the long leg too. Booking that as a plain close with the actual
  // net amount is honest; inventing an assignment branch for it would not be.
  return ["close", "expired"];
}

/** True when closing this position costs money rather than raising it. */
export function closeIsDebit(t: TradeType): boolean {
  return t !== "shares" && isCredit(t);
}

export interface ExitInput {
  path: ExitPath;
  /**
   * Magnitude of the closing transaction, always entered as a positive number.
   * Direction comes from the structure, not from the sign the user types.
   * Ignored for every path except `close`.
   */
  amount: number;
}

/**
 * Signed cash movement at exit.
 *
 * `expired` moves nothing — the premium already changed hands at open.
 * `assigned` buys the stock at the strike; `called_away` sells it there. In
 * both cases the strike amount is a *conversion* between cash and shares, not
 * a gain, which is why it is kept out of realizedPnl below.
 */
export function closingCashFlow(trade: Trade, exit: ExitInput): number {
  const t = trade.trade_type;
  switch (exit.path) {
    case "expired":
      return 0;
    case "assigned":
      return -(trade.strike ?? 0) * 100 * trade.qty;
    case "called_away":
      return (trade.strike ?? 0) * 100 * trade.qty;
    case "close": {
      const magnitude = Math.abs(exit.amount);
      return closeIsDebit(t) ? -magnitude : magnitude;
    }
  }
}

/**
 * Realized P&L for the position itself.
 *
 * For a plain close it is simply what came in minus what went out. For expiry
 * it is the opening flow — a credit kept in full, or a debit lost in full.
 *
 * Assignment and call-away are deliberately *not* opening + closing: the strike
 * proceeds belong to the resulting stock position, which carries its own basis.
 * The option's own result is the premium, and folding the strike in here would
 * book a stock purchase as an option loss.
 */
export function realizedPnl(trade: Trade, exit: ExitInput): number {
  const open = openingCashFlow(trade);
  switch (exit.path) {
    case "close":
      return open + closingCashFlow(trade, exit);
    case "expired":
      return open;
    case "assigned":
    case "called_away":
      return open;
  }
}

/** The ledger `kind` an exit path writes. */
export function exitFlowKind(path: ExitPath): CashFlowKind {
  switch (path) {
    case "close":
      return "trade_close";
    case "expired":
      return "expiry";
    case "assigned":
      return "assignment";
    case "called_away":
      return "called_away";
  }
}

export interface SharesDelta {
  /** Shares to add (assignment) or remove (call-away). Always positive. */
  shares: number;
  /** Per-share basis for a newly created lot. */
  basisPerShare: number;
  direction: "acquire" | "dispose";
}

/**
 * The stock movement an exit implies, or null when it moves no stock.
 *
 * An assigned short put delivers 100 shares per contract at the strike; a
 * called-away short call takes the same away. The premium is intentionally not
 * netted into the basis — it is already booked as the option's realized P&L,
 * and discounting the basis too would count it twice.
 */
export function sharesDelta(trade: Trade, path: ExitPath): SharesDelta | null {
  const strike = trade.strike ?? 0;
  if (path === "assigned") {
    return { shares: 100 * trade.qty, basisPerShare: strike, direction: "acquire" };
  }
  if (path === "called_away") {
    return { shares: 100 * trade.qty, basisPerShare: strike, direction: "dispose" };
  }
  return null;
}
