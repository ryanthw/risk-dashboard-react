import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { emptyDraft, type TradeDraft } from "@/components/trades/TradeFields";

/** How long a sandbox draft is preserved when navigating away (mirrors the
 *  original Streamlit draft_trade 10-minute TTL; shortened to 5 minutes). */
export const SANDBOX_TTL = 5 * 60 * 1000;

const fresh = (): TradeDraft => ({ ...emptyDraft(), trade_type: "csp" });

interface SandboxState {
  draft: TradeDraft;
  updatedAt: number;
  setDraft: (d: TradeDraft) => void;
  reset: () => void;
}

/**
 * Persists the Trade Analysis draft across page navigation (and reloads within
 * the browser session) so a user's in-progress work survives tab switches.
 * Callers should reset on mount if `updatedAt` is older than SANDBOX_TTL.
 */
export const useTradeSandboxStore = create<SandboxState>()(
  persist(
    (set) => ({
      draft: fresh(),
      updatedAt: Date.now(),
      setDraft: (d) => set({ draft: d, updatedAt: Date.now() }),
      reset: () => set({ draft: fresh(), updatedAt: Date.now() }),
    }),
    {
      name: "rd-trade-sandbox",
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);
