/** Domain types shared across the app and the financial engine. */

export const TRADE_TYPES = [
  "shares",
  "csp",
  "cc",
  "short_call",
  "short_put",
  "long_call",
  "long_put",
  "pcs",
  "ccs",
  "cds",
  "pds",
] as const;

export type TradeType = (typeof TRADE_TYPES)[number];

export const SPREAD_TYPES: TradeType[] = ["pcs", "ccs", "cds", "pds"];

/** Human-readable strategy names. */
export const TRADE_TYPE_LABELS: Record<TradeType, string> = {
  shares: "Long Equity",
  csp: "Cash-Secured Put",
  cc: "Covered Call",
  short_call: "Naked Call",
  short_put: "Naked Put",
  long_call: "Long Call",
  long_put: "Long Put",
  pcs: "Put Credit Spread",
  ccs: "Call Credit Spread",
  cds: "Call Debit Spread",
  pds: "Put Debit Spread",
};

/** Short-leg credit strategies — value counts against portfolio total. */
export const CREDIT_TYPES: TradeType[] = [
  "csp",
  "cc",
  "short_put",
  "short_call",
  "pcs",
  "ccs",
];

export function isSpread(t: TradeType): boolean {
  return SPREAD_TYPES.includes(t);
}

/** A position as stored in the DB (structured — no pickle blob). */
export interface Trade {
  id: string;
  user_id: string;
  portfolio_id: string;
  trade_type: TradeType;
  ticker: string;
  qty: number;
  strike: number | null;
  strike_2: number | null;
  premium: number | null;
  iv: number; // decimal, 0.20 = 20%
  expiration: string | null; // ISO date
  underlying_price: number | null;
  /** Per-share entry price for shares trades (options carry basis in premium). */
  cost_basis: number | null;
  sector: string;
  beta: number;
  opened_at: string;
  updated_at: string;
}

/** Fields needed to create a trade (server fills ids/timestamps). */
export interface TradeInput {
  portfolio_id: string;
  trade_type: TradeType;
  ticker: string;
  qty: number;
  strike: number | null;
  strike_2: number | null;
  premium: number | null;
  iv: number;
  expiration: string | null;
  underlying_price: number | null;
  cost_basis?: number | null;
  sector?: string;
  beta?: number;
  /** When the position was opened. Omitted means now (the column default). */
  opened_at?: string;
}

export interface Portfolio {
  id: string;
  user_id: string;
  name: string;
  cash: number;
  created_at: string;
}

export interface HistoryTrade {
  id: string;
  user_id: string;
  portfolio_id: string | null;
  ticker: string;
  trade_type: TradeType;
  entry_date: string | null;
  exit_date: string | null;
  /** Null when the result is genuinely unknown — e.g. stock sold with no
   *  recorded cost basis. Not the same as zero. */
  realized_pnl: number | null;
  iv_at_close: number;
  max_loss: number;
  final_value: number;
  created_at: string;
}

export interface Snapshot {
  id: string;
  user_id: string;
  portfolio_id: string;
  ts: string;
  net_liquidity: number;
  weighted_delta: number;
  expected_profit_total: number;
  erpa: number;
}

/**
 * Ledger row kinds. The first three change the capital base (external); the
 * rest are the portfolio earning or losing its own money. See
 * `engine/cashFlow.isExternal` — the split is what makes TWR meaningful.
 */
export type CashFlowKind =
  | "opening_balance"
  | "deposit"
  | "withdrawal"
  | "trade_open"
  | "trade_close"
  | "assignment"
  | "called_away"
  | "expiry"
  | "dividend"
  | "fee"
  | "adjustment";

export interface CashFlow {
  id: string;
  user_id: string;
  portfolio_id: string;
  ts: string;
  /** Signed: positive moves cash into the account. */
  amount: number;
  kind: CashFlowKind;
  trade_id: string | null;
  ticker: string | null;
  note: string | null;
  created_at: string;
}

/** Live market data for a ticker, fetched via the edge function. */
export interface MarketQuote {
  ticker: string;
  price: number;
  sector: string;
  beta: number;
  hv: number; // 30-day historical volatility (decimal)
}
