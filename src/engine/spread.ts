/**
 * Which leg of a spread is long and which is short.
 *
 * Read from the strike *pair*, never from which column a number landed in.
 * The two debit spreads used to be stored with the long leg in `strike` and
 * the short in `strike_2`, the reverse of the credit spreads and of what the
 * entry form asks for, so a correctly typed call debit spread simulated as an
 * inverted one: expected loss deeper than max loss, delta the wrong sign, POP
 * zero. Deriving the roles instead means entry order cannot express a position
 * that does not exist, and rows already stored either way read correctly.
 *
 * The invariant that makes this derivable is the definition of the structures
 * themselves. One leg of the pair is always worth more — the higher strike for
 * puts, the lower for calls. Being short that leg is what makes a spread a
 * credit; being long it is what makes it a debit. So the credit/debit type
 * fixes the roles once the strikes are ordered.
 */
import { isSpread, type TradeType } from "@/types";

export interface SpreadLegs {
  kind: "call" | "put";
  /** Long strike, or null when only one strike was entered. */
  long: number | null;
  /** Short strike, or null when only one strike was entered. */
  short: number | null;
}

/**
 * Resolve a spread's legs, or null if the type is not a spread.
 *
 * A missing or zero second strike is an incomplete entry, not a wing at zero:
 * the position is reported as the single leg its type implies — short for a
 * credit spread, long for a debit one — which is how the payoff and pricing
 * code has always degraded, rather than pricing a strike-0 option.
 */
export function spreadLegs(
  type: TradeType,
  strike: number | null,
  strike2: number | null,
): SpreadLegs | null {
  if (!isSpread(type)) return null;

  const kind = type === "pcs" || type === "pds" ? "put" : "call";
  const credit = type === "pcs" || type === "ccs";
  const K1 = strike ?? 0;
  const K2 = strike2 ?? 0;

  if (K1 <= 0 && K2 <= 0) return { kind, long: null, short: null };
  if (K2 <= 0 || K1 <= 0) {
    const only = K1 > 0 ? K1 : K2;
    return credit
      ? { kind, long: null, short: only }
      : { kind, long: only, short: null };
  }

  // The more valuable of the two: higher strike for puts, lower for calls.
  const dearer = kind === "put" ? Math.max(K1, K2) : Math.min(K1, K2);
  const cheaper = kind === "put" ? Math.min(K1, K2) : Math.max(K1, K2);

  return credit
    ? { kind, long: cheaper, short: dearer }
    : { kind, long: dearer, short: cheaper };
}

/** True for the spread types that are opened for a net credit. */
export function isCreditSpread(type: TradeType): boolean {
  return type === "pcs" || type === "ccs";
}
