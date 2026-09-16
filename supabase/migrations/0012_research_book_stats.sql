-- ============================================================================
-- 0012_research_book_stats — the outbound half of the research boundary
--
-- Research reads this app's own trades, derives what they say about how each
-- book has actually performed, and writes the result back here for the
-- Portfolio Insights tab to read. Same one-way contract as
-- earnings_reliability and income_universe: this repo owns the schema and a
-- select-only policy, and the private research repo is the only write path.
--
--   research-sandbox  --(db/seeds)-->  research_book_stats  -->  this app
--       private                                                  READ ONLY
--
-- One difference from the other two research tables, and it matters: those hold
-- shared reference data readable by any authenticated user. This holds a
-- person's own trading record, so RLS scopes it to auth.uid() exactly like
-- trades and history_trades. It is reference data about *you*.
--
-- ---------------------------------------------------------------------------
-- Shape: one table, four grains.
--
-- `grain` says what a row is keyed by — the portfolio as a whole, a structure
-- within it, a ticker within it, or a ticker-and-structure pair. `ticker` and
-- `trade_type` are '' where the grain does not use them, rather than null, so
-- they can sit in the primary key.
--
-- A portfolio is the in-practice boundary of a strategy — the books are
-- deliberately doing different things — so portfolio_id leads every key and no
-- row ever spans two of them. Pooled, this account's cash-secured puts read 73%
-- win; split, they are 83% in one book and 40% in another, a figure that
-- described neither.
--
-- ---------------------------------------------------------------------------
-- Every measure carries its own sample count, and they diverge sharply:
--
--   n                      trades in the group
--   n_pnl                  trades with a known result — win_rate's denominator
--   n_ror                  trades with a usable capital-at-risk denominator
--   n_full                 trades archived after 0011, carrying entry detail
--   n_dte / n_iv / n_itm / n_exit_path / n_moneyness / n_premium_yield
--                          the post-0011 subset each of those rests on
--
-- Most of the richer columns — moneyness at entry, IV at open versus that
-- expiration's ATM, exit path, how much of max gain was captured — are null for
-- every trade archived before 0011 and always will be: those rows have no
-- strike, premium, quantity or exit path to reason from. They are created here
-- now so the schema is already right when the first full-detail trade closes.
-- A consumer must read the matching n before rendering any rate, or it will
-- eventually show a 100% win rate drawn from a single trade.
-- ============================================================================

create table if not exists public.research_book_stats (
  user_id          uuid not null references auth.users (id) on delete cascade,
  portfolio_id     uuid not null,
  grain            text not null
                     check (grain in ('portfolio','strategy','ticker','ticker_strategy')),
  -- '' rather than null where the grain does not use them: primary keys cannot
  -- contain nulls, and a sentinel that sorts and compares is easier to join on.
  ticker           text not null default '',
  trade_type       text not null default '',
  portfolio_name   text,

  n                              integer,
  n_full                         integer,
  n_pnl                          integer,
  n_wins                         integer,
  win_rate                       numeric,
  total_pnl                      numeric,
  mean_pnl                       numeric,
  median_pnl                     numeric,
  best_pnl                       numeric,
  worst_pnl                      numeric,
  profit_factor                  numeric,
  expectancy                     numeric,
  n_ror                          integer,
  mean_ror                       numeric,
  median_ror                     numeric,
  mean_ann_ror                   numeric,
  n_return_on_premium            integer,
  mean_return_on_premium         numeric,
  mean_pct_max_gain_captured     numeric,
  mean_hold_days                 numeric,
  median_hold_days               numeric,
  n_dte                          integer,
  mean_dte_at_entry              numeric,
  mean_dte_held_pct              numeric,
  n_moneyness                    integer,
  mean_moneyness_at_entry        numeric,
  n_premium_yield                integer,
  mean_premium_yield_ann         numeric,
  n_iv                           integer,
  mean_iv_at_open                numeric,
  mean_iv_vs_atm_at_open         numeric,
  mean_iv_change_pct             numeric,
  n_exit_path                    integer,
  rate_expired                   numeric,
  rate_assigned                  numeric,
  rate_called_away               numeric,
  rate_closed_early              numeric,
  n_itm                          integer,
  rate_finished_itm              numeric,
  rate_move_favored              numeric,
  mean_underlying_move_pct       numeric,
  first_exit                     timestamptz,
  last_exit                      timestamptz,

  -- When the research side last derived these rows, so the UI can say how
  -- fresh the answer is rather than implying it is live.
  as_of            date not null,
  updated_at       timestamptz not null default now(),

  primary key (user_id, portfolio_id, grain, ticker, trade_type)
);

create index if not exists research_book_stats_lookup
  on public.research_book_stats (user_id, portfolio_id, grain);

alter table public.research_book_stats enable row level security;

-- Read-only to the app, and only your own rows. There is deliberately no
-- insert/update/delete policy: the research side writes with the service role.
drop policy if exists "book stats readable by owner" on public.research_book_stats;
create policy "book stats readable by owner"
  on public.research_book_stats for select
  to authenticated using (auth.uid() = user_id);

-- ---- rows are loaded externally --------------------------------------------
-- Seed rows live in the private research repo (ryanthw/research-sandbox,
-- db/seeds/), generated by scripts/gen_book_stats_seed.py from book/. They are
-- research output and the research side is their only write path.
--
-- Self-hosting: the table is created empty and the Portfolio Insights tab shows
-- an empty state until you populate it with your own data.

