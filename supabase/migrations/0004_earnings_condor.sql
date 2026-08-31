-- ============================================================================
-- Earnings reliability — add iron-condor stat columns.
-- The scanner offers a butterfly|condor structure toggle, so the reliability
-- table carries condor_n / condor_win / condor_mean_ror alongside the butterfly
-- columns. Values are loaded externally; this migration only adds the columns.
-- Idempotent — safe to re-run.
-- ============================================================================
alter table public.earnings_reliability add column if not exists condor_n int;
alter table public.earnings_reliability add column if not exists condor_win numeric;
alter table public.earnings_reliability add column if not exists condor_mean_ror numeric;

-- Seed rows for this table live in the private research repo
-- (ryanthw/research-sandbox, db/seeds/). They are research output, and the
-- research side is their only write path. This repo owns the schema and the
-- select-only read policy; it never writes these rows.
--
-- Self-hosting: the table is created empty and the dependent scanner will
-- return nothing until you populate it with your own data.
