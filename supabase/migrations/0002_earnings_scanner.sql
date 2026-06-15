-- ============================================================================
-- Earnings short-vol scanner — reference data
-- earnings_reliability: per-ticker historical iron-butterfly / straddle stats,
-- computed from the research backtest (real DoltHub option history + yfinance
-- realized moves, S&P 500, 2020-2025). Reference data shared by all users.
-- Regenerate/extend via research/scripts/butterfly.py -> ticker_reliability.json.
-- ============================================================================
create table if not exists public.earnings_reliability (
  ticker            text primary key,
  n                 int not null,                 -- # backtested earnings events
  fly_win           numeric,                      -- iron-butterfly win rate (0-1)
  fly_mean_ror      numeric,                      -- mean return on max-risk
  straddle_win      numeric,                      -- naked straddle win rate
  straddle_mean     numeric,                      -- mean straddle return (% premium)
  avg_implied       numeric,                      -- avg implied move (decimal)
  avg_actual        numeric,                      -- avg realized |move| (decimal)
  atm_iv            numeric,                      -- avg pre-earnings ATM IV
  premium_richness  numeric,                      -- avg_implied / avg_actual
  updated_at        timestamptz not null default now()
);

alter table public.earnings_reliability enable row level security;

drop policy if exists "reliability readable by authenticated" on public.earnings_reliability;
create policy "reliability readable by authenticated"
  on public.earnings_reliability for select
  to authenticated using (true);

-- ---------------------------------------------------------------------------
-- earnings_scan_cache: most-recent scan payload (one row per window key) so the
-- page loads instantly and we only hit Yahoo/Finnhub on an explicit refresh.
-- Written only by the edge function (service role); readable by authenticated.
-- ---------------------------------------------------------------------------
create table if not exists public.earnings_scan_cache (
  id          text primary key,           -- window key, e.g. '7d'
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.earnings_scan_cache enable row level security;

drop policy if exists "scan cache readable by authenticated" on public.earnings_scan_cache;
create policy "scan cache readable by authenticated"
  on public.earnings_scan_cache for select
  to authenticated using (true);

-- ---- seed (research backtest, 372 names) -------------------------------------
-- Seed rows for this table live in the private research repo
-- (ryanthw/research-sandbox, db/seeds/). They are research output, and the
-- research side is their only write path. This repo owns the schema and the
-- select-only read policy; it never writes these rows.
--
-- Self-hosting: the table is created empty and the dependent scanner will
-- return nothing until you populate it with your own data.
