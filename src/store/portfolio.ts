import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PortfolioState {
  activePortfolioId: string | null;
  setActivePortfolio: (id: string | null) => void;
}

/** Tracks the currently selected portfolio across pages (persisted). */
export const usePortfolioStore = create<PortfolioState>()(
  persist(
    (set) => ({
      activePortfolioId: null,
      setActivePortfolio: (id) => set({ activePortfolioId: id }),
    }),
    { name: "rd-active-portfolio" },
  ),
);
