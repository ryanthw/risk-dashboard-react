-- ============================================================================
-- IV Surface (SPY double-diagonal scanner)
--
-- iv_surface_cache: most-recent full delta-bucketed IV surface payload per
--   ticker (currently SPY only), written by the iv-surface edge function
--   (service role) and served back within its 15-min TTL so tab visits don't
--   re-pull ~15-20 Public option chains. Separate from vol_surface_cache —
--   that table holds the Basis Tracker's per-ticker ATM/25Δ reduction, this
--   one holds the full smile grid the surface charts need.
-- ============================================================================

create table if not exists public.iv_surface_cache (
  ticker      text primary key,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.iv_surface_cache enable row level security;

drop policy if exists "iv surface cache readable by authenticated" on public.iv_surface_cache;
create policy "iv surface cache readable by authenticated"
  on public.iv_surface_cache for select
  to authenticated using (true);
