/**
 * Env and sign-in shared by the headless scripts (snapshot, report).
 *
 * Both authenticate as a real account through RLS, and both have hit the same
 * failure: a value that arrives subtly different from what is on disk fails
 * auth as "Invalid login credentials" with nothing to say why.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Strips what env files smuggle in: CRLF carriage returns, stray surrounding
 * whitespace, and matching wrapper quotes. A password arriving with a trailing
 * \r fails auth with the same "Invalid login credentials" as a wrong password,
 * which is indistinguishable without this.
 */
function clean(raw: string): string {
  let v = raw.trim();
  const q = v[0];
  if (v.length >= 2 && (q === '"' || q === "'") && v.endsWith(q)) {
    v = v.slice(1, -1);
  }
  return v;
}

/** Names whose value was altered by clean(), for the failure diagnostic. */
const sanitized = new Set<string>();

/**
 * Reads the first name that is set. The VITE_-prefixed fallbacks let a local
 * run reuse .env.local instead of duplicating the same URL and key under a
 * second set of names; CI supplies the unprefixed ones as secrets.
 */
export function required(...names: string[]): string {
  for (const n of names) {
    const raw = process.env[n];
    if (raw == null || raw === "") continue;
    const v = clean(raw);
    if (v !== raw) sanitized.add(n);
    return v;
  }
  console.error(`Missing required env var: ${names.join(" or ")}`);
  process.exit(2);
}

/** Signs in with the account's own credentials; exits with a diagnostic on failure. */
export async function signIn(): Promise<{ client: SupabaseClient; userId: string; email: string }> {
  const url = required("SUPABASE_URL", "VITE_SUPABASE_URL");
  const anonKey = required("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY");
  const email = required("SUPABASE_EMAIL");
  const password = required("SUPABASE_PASSWORD");

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: auth, error: authErr } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (authErr || !auth.user) {
    console.error(`Sign-in failed: ${authErr?.message ?? "no user returned"}`);
    // Enough to spot a malformed env value without printing the secret.
    console.error(`  email        ${JSON.stringify(email)}`);
    console.error(`  password     ${password.length} chars`);
    console.error(`  project host ${new URL(url).host}`);
    if (sanitized.size > 0) {
      console.error(
        `  note: stripped quotes/whitespace from ${[...sanitized].join(", ")}`,
      );
    }
    console.error(
      "  If the password length is wrong, the env file is mangling it — try\n" +
        "  single-quoting the value, or export it in the shell instead.",
    );
    process.exit(1);
  }
  return { client, userId: auth.user.id, email };
}
