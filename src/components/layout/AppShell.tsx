import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { AlertTriangle } from "lucide-react";

function ConfigBanner() {
  if (isSupabaseConfigured) return null;
  return (
    <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-300">
      <AlertTriangle className="h-4 w-4" />
      Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in
      .env.local to enable data persistence.
    </div>
  );
}

export function AppShell() {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <ConfigBanner />
        <main className="flex-1 overflow-y-auto scrollbar-thin p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
