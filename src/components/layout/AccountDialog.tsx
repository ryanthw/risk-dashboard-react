import { useState } from "react";
import { Loader2, KeyRound } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useAuth } from "@/store/auth";
import { supabase } from "@/lib/supabase";

const MIN_LEN = 6;

export function AccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { user, updatePassword } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const resetFields = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < MIN_LEN) {
      toast.error(`Password must be at least ${MIN_LEN} characters`);
      return;
    }
    if (next !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    if (next === current) {
      toast.error("New password must be different");
      return;
    }
    setBusy(true);
    try {
      // Re-verify the current password before allowing a change.
      if (user?.email) {
        const { error: vErr } = await supabase.auth.signInWithPassword({
          email: user.email,
          password: current,
        });
        if (vErr) {
          toast.error("Current password is incorrect");
          setBusy(false);
          return;
        }
      }
      await updatePassword(next);
      toast.success("Password updated");
      resetFields();
      onOpenChange(false);
    } catch (err) {
      toast.error("Could not update password", String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) resetFields();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>{user?.email}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Change Password
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="cur">Current password</Label>
            <Input
              id="cur"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np">New password</Label>
            <Input
              id="np"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp">Confirm new password</Label>
            <Input
              id="cp"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Update Password
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
