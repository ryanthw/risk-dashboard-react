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
  FileText,
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
  { to: "/reports", label: "Reports", icon: FileText },
];

export function Sidebar() {
  const { user, signOut } = useAuth();
  const [accountOpen, setAccountOpen] = useState(false);

  return (
    <aside className="no-print flex h-full w-64 flex-col border-r border-border bg-card/40">
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
                "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
                "transition-[background-color,color] duration-fast ease-out",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                isActive
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                {/* Active rail — anchors the eye to the current section. */}
                <span
                  className={cn(
                    "absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-primary",
                    "transition-opacity duration-fast ease-out",
                    isActive ? "opacity-100" : "opacity-0",
                  )}
                />
                <Icon
                  className={cn(
                    "h-4 w-4 transition-transform duration-fast ease-out",
                    !isActive && "group-hover:scale-110",
                  )}
                />
                {label}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-border p-3">
        <button
          onClick={() => setAccountOpen(true)}
          className="mb-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors duration-fast ease-out hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <UserCog className="h-4 w-4 shrink-0" />
          <span className="truncate">{user?.email}</span>
        </button>
        <button
          onClick={() => signOut()}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-fast ease-out hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
      <AccountDialog open={accountOpen} onOpenChange={setAccountOpen} />
    </aside>
  );
}
