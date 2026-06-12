import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePortfolios } from "@/api/portfolios";
import { usePortfolioStore } from "@/store/portfolio";
import { PortfolioManager } from "./PortfolioManager";

export function PortfolioSwitcher() {
  const { data: portfolios } = usePortfolios();
  const { activePortfolioId, setActivePortfolio } = usePortfolioStore();
  const [manageOpen, setManageOpen] = useState(false);

  // Keep the active selection valid as portfolios load/change.
  useEffect(() => {
    if (!portfolios) return;
    const exists = portfolios.some((p) => p.id === activePortfolioId);
    if (!exists) setActivePortfolio(portfolios[0]?.id ?? null);
  }, [portfolios, activePortfolioId, setActivePortfolio]);

  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={activePortfolioId ?? undefined}
        onValueChange={(v) => setActivePortfolio(v)}
      >
        <SelectTrigger className="h-9 flex-1">
          <SelectValue placeholder="Select portfolio" />
        </SelectTrigger>
        <SelectContent>
          {(portfolios ?? []).map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
          {portfolios?.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No portfolios yet
            </div>
          )}
        </SelectContent>
      </Select>
      <button
        onClick={() => setManageOpen(true)}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Manage portfolios"
      >
        <Settings2 className="h-4 w-4" />
      </button>
      <PortfolioManager open={manageOpen} onOpenChange={setManageOpen} />
    </div>
  );
}
