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
insert into public.income_universe (ticker, sector, beta) values
  ('F',    'Automobiles',            1.3),
  ('SOFI', 'Financial Services',     1.8),
  ('INTC', 'Semiconductors',         1.0),
  ('PLTR', 'Technology',             2.5),
  ('NIO',  'Automobiles',            2.0),
  ('XPEV', 'Automobiles',            2.2),
  ('LCID', 'Automobiles',            1.9),
  ('RIVN', 'Automobiles',            2.1),
  ('CHPT', 'Industrials',            2.3),
  ('PLUG', 'Energy',                 2.5),
  ('RUN',  'Energy',                 2.6),
  ('FCEL', 'Energy',                 2.4),
  ('WBD',  'Media',                  1.4),
  ('PARA', 'Media',                  1.5),
  ('SNAP', 'Media',                  1.4),
  ('PINS', 'Media',                  1.3),
  ('GRAB', 'Technology',             1.6),
  ('IQ',   'Media',                  1.8),
  ('BBAI', 'Technology',             2.8),
  ('SOUN', 'Technology',             3.0),
  ('LUMN', 'Telecommunication',      1.7),
  ('NOK',  'Telecommunication',      0.8),
  ('T',    'Telecommunication',      0.6),
  ('VOD',  'Telecommunication',      0.7),
  ('VALE', 'Basic Materials',        1.2),
  ('CLF',  'Basic Materials',        1.8),
  ('KGC',  'Basic Materials',        0.9),
  ('GOLD', 'Basic Materials',        0.8),
  ('AG',   'Basic Materials',        1.4),
  ('HL',   'Basic Materials',        1.3),
  ('CDE',  'Basic Materials',        1.5),
  ('BTG',  'Basic Materials',        1.0),
  ('AMCR', 'Basic Materials',        0.7),
  ('UEC',  'Energy',                 1.9),
  ('DNN',  'Energy',                 2.0),
  ('RIG',  'Energy',                 2.7),
  ('KMI',  'Energy',                 0.9),
  ('AES',  'Utilities',              1.0),
  ('CCL',  'Consumer Discretionary', 2.3),
  ('NCLH', 'Consumer Discretionary', 2.4),
  ('AAL',  'Industrials',            1.5),
  ('JBLU', 'Industrials',            1.6),
  ('KSS',  'Retail',                 1.5),
  ('M',    'Retail',                 1.4),
  ('GAP',  'Retail',                 1.4),
  ('WBA',  'Consumer Staples',       0.9),
  ('KVUE', 'Consumer Staples',       0.5),
  ('NWL',  'Consumer Staples',       1.3),
  ('KEY',  'Banking',                1.2),
  ('HBAN', 'Banking',                1.1),
  ('RF',   'Banking',                1.1),
  ('FITB', 'Banking',                1.2),
  ('RKT',  'Financial Services',     2.0),
  ('HBI',  'Consumer Discretionary', 1.4),
  ('UAA',  'Consumer Discretionary', 1.5),
  ('PTON', 'Consumer Discretionary', 2.5),
  ('VFC',  'Consumer Discretionary', 1.5),
  ('SIRI', 'Media',                  1.0),
  ('RXRX', 'Biotechnology',          2.5),
  ('MARA', 'Technology',             4.0),
  ('RIOT', 'Technology',             4.0),
  ('CLSK', 'Technology',             4.0),
  ('WULF', 'Technology',             3.5),
  ('RGTI', 'Technology',             3.5),
  ('QBTS', 'Technology',             3.5),
  ('OPEN', 'Real Estate',            3.0)
on conflict (ticker) do update set
  sector = excluded.sector, beta = excluded.beta, updated_at = now();
