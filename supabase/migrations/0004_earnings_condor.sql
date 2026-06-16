-- ============================================================================
-- Earnings reliability — add iron-CONDOR stats (1104 names).
-- The scanner now offers a butterfly|condor structure toggle; the condor is the
-- smoother backtested structure (PF 2.4, positive every quarter). Columns
-- condor_n/condor_win/condor_mean_ror come from the same DoltHub backtest
-- (Δ16 short body / Δ5 wings). Idempotent — safe to re-run.
-- Regenerate via research/scripts/gen_reliability_migration.py.
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
