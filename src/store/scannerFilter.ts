import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ScannerStructure = "butterfly" | "condor";

interface ScannerFilterState {
  /** Option structure the scanner suggests/ranks: iron butterfly (default) or iron condor. */
  structure: ScannerStructure;
  /** When on, hide candidates whose per-contract max loss exceeds maxLossPct of the account. */
  affordableOnly: boolean;
  /** Max-loss budget as a percent of the active portfolio value. */
  maxLossPct: number;
  setStructure: (v: ScannerStructure) => void;
  setAffordableOnly: (v: boolean) => void;
  setMaxLossPct: (v: number) => void;
}

/**
 * Earnings-scanner affordability filter. Persisted to localStorage so the checkbox
 * and percent survive timeframe switches (3D/7D/14D), navigation, and reloads, and
 * apply uniformly across every timeframe. Off by default — the scanner is unchanged
 * until the user opts in.
 */
export const useScannerFilterStore = create<ScannerFilterState>()(
  persist(
    (set) => ({
      structure: "butterfly",
      affordableOnly: false,
      maxLossPct: 5,
      setStructure: (v) => set({ structure: v }),
      setAffordableOnly: (v) => set({ affordableOnly: v }),
      setMaxLossPct: (v) => set({ maxLossPct: v }),
    }),
    { name: "rd-scanner-filter" },
  ),
);
