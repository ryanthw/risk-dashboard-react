import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * True when Supabase env vars are present. When false the app runs in a
 * "demo / not configured" state and surfaces setup instructions instead of
 * crashing — useful before the backend keys are dropped in.
 */
export const isSupabaseConfigured = Boolean(url && anonKey);

/**
 * The Supabase client. If env vars are missing we still create a client with
 * placeholder values so imports don't throw; calls will simply fail and the UI
 * guards on `isSupabaseConfigured`.
 */
export const supabase: SupabaseClient = createClient(
  url ?? "https://placeholder.supabase.co",
  anonKey ?? "placeholder-anon-key",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);
