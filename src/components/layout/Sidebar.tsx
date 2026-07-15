import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  BarChart3,
  Target,
  History as HistoryIcon,
  FlaskConical,
  Radar,
  Banknote,
  Layers,
  LogOut,
  TrendingUp,
  UserCog,
  Waves,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useAuth } from "@/store/auth";
import { PortfolioSwitcher } from "./PortfolioSwitcher";
import { AccountDialog } from "./AccountDialog";

const nav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/visuals", label: "Visuals", icon: BarChart3 },
  { to: "/strategy", label: "Strategy", icon: Target },
  { to: "/history", label: "History", icon: HistoryIcon },
  { to: "/analysis", label: "Trade Analysis", icon: FlaskConical },
  { to: "/scanner", label: "Earnings Scanner", icon: Radar },
  { to: "/income-scanner", label: "Income Scanner", icon: Banknote },
  { to: "/basis", label: "Basis Tracker", icon: Layers },
  { to: "/iv-surface", label: "IV Surface", icon: Waves },
];

export function Sidebar() {
  const { user, signOut } = useAuth();
  const [accountOpen, setAccountOpen] = useState(false);

  return (
    <aside className="flex h-full w-64 flex-col border-r border-border bg-card/40">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15">
          <TrendingUp className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="text-sm font-semibold leading-tight">Risk Dashboard</p>
          <p className="text-[0.7rem] text-muted-foreground">Options & Equity</p>
        </div>
      </div>

      <div className="px-3 pb-2">
        <PortfolioSwitcher />
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {nav.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-border p-3">
        <button
          onClick={() => setAccountOpen(true)}
          className="mb-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <UserCog className="h-4 w-4 shrink-0" />
          <span className="truncate">{user?.email}</span>
        </button>
        <button
          onClick={() => signOut()}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
      <AccountDialog open={accountOpen} onOpenChange={setAccountOpen} />
    </aside>
  );
}
