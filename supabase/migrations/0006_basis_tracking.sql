-- ============================================================================
-- Basis Tracker
--
-- trades.cost_basis: per-share entry price. The Basis Tracker needs the amount
--   actually paid for share lots, and `underlying_price` can't serve — every
--   market-data refresh overwrites it with the live quote. Nullable; only
--   meaningful for trade_type = 'shares' (option entry cost already lives in
--   `premium`). Backfilled once from underlying_price as the best available
--   approximation — edit per-trade if the true fill differs.
--
-- vol_surface_cache: most-recent vol-surface payload per ticker, written by the
--   vol-surface edge function (service role), served back within its 15-min TTL
--   so opening the Basis Tracker doesn't hammer the Public API on every visit.
-- ============================================================================

alter table public.trades add column if not exists cost_basis numeric;

update public.trades
  set cost_basis = underlying_price
  where trade_type = 'shares' and cost_basis is null;

create table if not exists public.vol_surface_cache (
  ticker      text primary key,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.vol_surface_cache enable row level security;

drop policy if exists "vol surface cache readable by authenticated" on public.vol_surface_cache;
create policy "vol surface cache readable by authenticated"
  on public.vol_surface_cache for select
  to authenticated using (true);
