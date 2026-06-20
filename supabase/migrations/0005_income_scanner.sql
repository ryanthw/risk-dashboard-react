-- ============================================================================
-- Income Scanner — cash-secured-put opportunity finder
--
-- income_universe: a small, hand-curated list of liquid, low-priced optionable
--   names the scanner sweeps. Kept deliberately tight (sub-$25-ish so the live
--   "< $15 spot" filter has headroom) so a full scan stays fast and we land near
--   ~20 quality candidates after filtering. EDIT THIS LIST to tune coverage —
--   add/remove names or flip `active`. Sector strings should match Finnhub's
--   `finnhubIndustry` values (what `market-data` stamps on portfolio trades) so
--   the diversification rating lines up with your book.
--
-- income_scan_cache: the producer's most-recent computed payload (single row).
--   Written by the income-scanner edge function (service role), read by the UI.
--   The function lazily recomputes when the row is older than its 15-min TTL; a
--   true cron upgrade (see docs/income-scanner.md) can keep it always-fresh.
-- ============================================================================

create table if not exists public.income_universe (
  ticker      text primary key,
  sector      text not null default 'Unknown',  -- Finnhub-style industry label
  beta        numeric not null default 1.2,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);

alter table public.income_universe enable row level security;

drop policy if exists "income universe readable by authenticated" on public.income_universe;
create policy "income universe readable by authenticated"
  on public.income_universe for select
  to authenticated using (true);

create table if not exists public.income_scan_cache (
  id          text primary key,          -- always 'default' (single payload)
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.income_scan_cache enable row level security;

drop policy if exists "income scan cache readable by authenticated" on public.income_scan_cache;
create policy "income scan cache readable by authenticated"
  on public.income_scan_cache for select
  to authenticated using (true);

-- ---- seed universe (starting list — curate freely) --------------------------
-- Seed rows for this table live in the private research repo
-- (ryanthw/research-sandbox, db/seeds/). They are research output, and the
-- research side is their only write path. This repo owns the schema and the
-- select-only read policy; it never writes these rows.
--
-- Self-hosting: the table is created empty and the dependent scanner will
-- return nothing until you populate it with your own data.
