import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { AlertTriangle } from "lucide-react";

function ConfigBanner() {
  if (isSupabaseConfigured) return null;
  return (
    <div className="no-print flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-300">
      <AlertTriangle className="h-4 w-4" />
      Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in
      .env.local to enable data persistence.
    </div>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  return (
    // app-shell / app-main are print hooks, not styling: the shell is a fixed-
    // height scroll container, which prints as a single clipped page. The print
    // stylesheet releases the height and overflow on exactly these two nodes.
    <div className="app-shell flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="app-shell-body flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <ConfigBanner />
        <main className="app-main flex-1 overflow-y-auto scrollbar-thin p-6">
          {/* Keying on pathname replays the entry animation per navigation, so
              a route change reads as a new view rather than a content swap. */}
          <div key={pathname} className="animate-rise-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
