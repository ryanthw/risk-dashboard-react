/**
 * Basis Tracker derivation: turns the raw position list into per-lot "basis
 * cards" — share lots plus LEAPS-like long calls — each carrying cost basis,
 * unrealized P/L and covered-call coverage status.
 */
import type { Trade } from "@/types";
import type { Position } from "./portfolio";
import { theoreticalValue } from "./blackScholes";
import { dteDays } from "./trade";

/** Long calls qualify as stock-replacement ("LEAPS") above these floors. */
export const LEAPS_MIN_DTE_DAYS = 91; // > 3 months
export const LEAPS_MIN_DELTA = 0.5;

export type BasisKind = "shares" | "long_call";

export type CoverageStatus = "covered" | "partial" | "uncovered" | "ineligible";

export interface BasisPosition {
  trade: Trade;
  kind: BasisKind;
  /** Round lots this position can cover (floor(shares/100) or contracts). */
  lots: number;
  /** Covered-call contracts allocated to this position. */
  ccAllocated: number;
  coverage: CoverageStatus;
  /** Per-share entry price (cost_basis for shares, premium for calls). */
  basisPerShare: number | null;
  basisTotal: number | null;
  /** Current mark: spot*qty for shares, BSM value for calls (live mid can override in UI). */
  markTotal: number;
  unrealized: number | null;
  unrealizedPct: number | null;
  /** Model (BSM) per-contract delta for calls; 1 for shares. */
  delta: number;
  dte: number | null;
  breakeven: number | null;
  daysHeld: number;
  /** True when a shares row has no stored cost_basis (basis unknown). */
  basisMissing: boolean;
}

const MS_PER_DAY = 86_400_000;

function daysHeld(trade: Trade, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(trade.opened_at).getTime()) / MS_PER_DAY));
}

/** BSM per-contract delta for a long call (finite difference on one contract). */
export function longCallDelta(trade: Trade): number {
  const S = trade.underlying_price ?? 0;
  if (S <= 0 || !trade.strike) return 0;
  const T = dteDays(trade) / 365;
  const one = { ...trade, qty: 1 };
  const ds = S * 0.01;
  const v0 = theoreticalValue(one, S, T, trade.iv);
  const v1 = theoreticalValue(one, S + ds, T, trade.iv);
  return (v1 - v0) / ds / 100; // per-share delta of one contract
}

/** True when a long call is deep/long-dated enough to track like stock. */
export function isLeapsLike(trade: Trade): boolean {
  if (trade.trade_type !== "long_call") return false;
  if (dteDays(trade) <= LEAPS_MIN_DTE_DAYS) return false;
  return longCallDelta(trade) > LEAPS_MIN_DELTA;
}

function sharesCard(trade: Trade): Omit<BasisPosition, "ccAllocated" | "coverage"> {
  const spot = trade.underlying_price ?? 0;
  const basisPerShare = trade.cost_basis ?? null;
  const basisTotal = basisPerShare != null ? basisPerShare * trade.qty : null;
  const markTotal = spot * trade.qty;
  const unrealized = basisTotal != null ? markTotal - basisTotal : null;
  return {
    trade,
    kind: "shares",
    lots: Math.floor(trade.qty / 100),
    basisPerShare,
    basisTotal,
    markTotal,
    unrealized,
    unrealizedPct:
      unrealized != null && basisTotal ? (unrealized / basisTotal) * 100 : null,
    delta: 1,
    dte: null,
    breakeven: basisPerShare,
    daysHeld: daysHeld(trade),
    basisMissing: basisPerShare == null,
  };
}

function leapsCard(trade: Trade): Omit<BasisPosition, "ccAllocated" | "coverage"> {
  const spot = trade.underlying_price ?? 0;
  const prem = trade.premium ?? 0;
  const dte = dteDays(trade);
  const basisTotal = prem * 100 * trade.qty;
  const markTotal = theoreticalValue(trade, spot, dte / 365, trade.iv);
  const unrealized = markTotal - basisTotal;
  return {
    trade,
    kind: "long_call",
    lots: trade.qty,
    basisPerShare: prem,
    basisTotal,
    markTotal,
    unrealized,
    unrealizedPct: basisTotal > 0 ? (unrealized / basisTotal) * 100 : null,
    delta: longCallDelta(trade),
    dte,
    breakeven: (trade.strike ?? 0) + prem,
    daysHeld: daysHeld(trade),
    basisMissing: false,
  };
}

/**
 * Build basis cards from the book. Covered-call contracts are allocated per
 * ticker — share lots first (largest first), then LEAPS (nearest expiration
 * first) — so one CC never counts against two lots.
 */
export function deriveBasisPositions(positions: Position[]): BasisPosition[] {
  const trades = positions.map((p) => p.trade);

  const ccByTicker = new Map<string, number>();
  for (const t of trades) {
    if (t.trade_type === "cc") {
      ccByTicker.set(t.ticker, (ccByTicker.get(t.ticker) ?? 0) + t.qty);
    }
  }

  const cards = [
    ...trades.filter((t) => t.trade_type === "shares").map(sharesCard),
    ...trades.filter(isLeapsLike).map(leapsCard),
  ];

  // Group by ticker and allocate CC contracts.
  const byTicker = new Map<string, typeof cards>();
  for (const c of cards) {
    const arr = byTicker.get(c.trade.ticker) ?? [];
    arr.push(c);
    byTicker.set(c.trade.ticker, arr);
  }

  const out: BasisPosition[] = [];
  for (const [ticker, group] of byTicker) {
    let remaining = ccByTicker.get(ticker) ?? 0;
    const ordered = [...group].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "shares" ? -1 : 1;
      if (a.kind === "shares") return b.lots - a.lots;
      return (a.dte ?? 0) - (b.dte ?? 0);
    });
    for (const c of ordered) {
      const alloc = Math.min(remaining, c.lots);
      remaining -= alloc;
      const coverage: CoverageStatus =
        c.lots === 0
          ? "ineligible"
          : alloc === 0
            ? "uncovered"
            : alloc < c.lots
              ? "partial"
              : "covered";
      out.push({ ...c, ccAllocated: alloc, coverage });
    }
  }

  // Stable presentation: largest basis first.
  return out.sort((a, b) => (b.basisTotal ?? b.markTotal) - (a.basisTotal ?? a.markTotal));
}
