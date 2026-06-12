import { useState } from "react";
import { Trash2, Plus, Wallet } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  usePortfolios,
  useCreatePortfolio,
  useDeletePortfolio,
  useUpdateCash,
} from "@/api/portfolios";
import { usePortfolioStore } from "@/store/portfolio";
import { fmtUsd } from "@/lib/format";

export function PortfolioManager({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data: portfolios } = usePortfolios();
  const { activePortfolioId, setActivePortfolio } = usePortfolioStore();
  const createMut = useCreatePortfolio();
  const deleteMut = useDeletePortfolio();
  const cashMut = useUpdateCash();

  const [newName, setNewName] = useState("");
  const active = portfolios?.find((p) => p.id === activePortfolioId);
  const [cash, setCash] = useState<string>("");

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    if (portfolios?.some((p) => p.name === name)) {
      toast.error("Name already exists");
      return;
    }
    try {
      const created = await createMut.mutateAsync(name);
      setActivePortfolio(created.id);
      setNewName("");
      toast.success(`Created "${name}"`);
    } catch (e) {
      toast.error("Could not create portfolio", String((e as Error).message));
    }
  };

  const handleDelete = async (id: string, name: string) => {
    try {
      await deleteMut.mutateAsync(id);
      if (id === activePortfolioId) setActivePortfolio(null);
      toast.success(`Deleted "${name}"`);
    } catch (e) {
      toast.error("Delete failed", String((e as Error).message));
    }
  };

  const handleCash = async () => {
    if (!active) return;
    const val = Number(cash);
    if (!Number.isFinite(val)) return;
    try {
      await cashMut.mutateAsync({ id: active.id, cash: val });
      toast.success("Cash updated");
      setCash("");
    } catch (e) {
      toast.error("Update failed", String((e as Error).message));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage Portfolios</DialogTitle>
          <DialogDescription>
            Create, fund, or remove portfolios. Each is isolated to your account.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="create" className="mt-2">
          <TabsList className="w-full">
            <TabsTrigger value="create" className="flex-1">
              Create
            </TabsTrigger>
            <TabsTrigger value="cash" className="flex-1">
              Cash
            </TabsTrigger>
            <TabsTrigger value="manage" className="flex-1">
              Remove
            </TabsTrigger>
          </TabsList>

          <TabsContent value="create" className="space-y-3 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="pname">New portfolio name</Label>
              <Input
                id="pname"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Income Wheel"
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
            </div>
            <Button onClick={handleCreate} disabled={createMut.isPending} className="w-full">
              <Plus className="h-4 w-4" /> Create Portfolio
            </Button>
          </TabsContent>

          <TabsContent value="cash" className="space-y-3 pt-2">
            {active ? (
              <>
                <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Current cash · </span>
                  <span className="font-semibold tnum">{fmtUsd(active.cash)}</span>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cash">New cash balance</Label>
                  <Input
                    id="cash"
                    type="number"
                    value={cash}
                    onChange={(e) => setCash(e.target.value)}
                    placeholder={String(active.cash)}
                  />
                </div>
                <Button onClick={handleCash} disabled={cashMut.isPending} className="w-full">
                  <Wallet className="h-4 w-4" /> Update Balance
                </Button>
              </>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Select a portfolio first.
              </p>
            )}
          </TabsContent>

          <TabsContent value="manage" className="space-y-2 pt-2">
            {portfolios?.length ? (
              portfolios.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <div className="text-sm">
                    <span className="font-medium">{p.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground tnum">
                      {fmtUsd(p.cash)}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-loss hover:text-loss"
                    onClick={() => handleDelete(p.id, p.name)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No portfolios to remove.
              </p>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
