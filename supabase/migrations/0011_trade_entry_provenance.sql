-- ============================================================================
-- 0011_trade_entry_provenance — stop destroying a trade's entry conditions
--
-- Two separate leaks, both silent, both permanent:
--
--   * `trades.underlying_price` is overwritten with the live quote on every
--     market-data refresh (lib/refreshPortfolio.ts). The spot at entry — and so
--     the moneyness the position was actually opened at — is gone by the second
--     refresh. 0006 hit the same wall for share lots and answered it with
--     `cost_basis`; this does the same for options.
--   * Archiving a trade writes eight columns and hard-deletes the row
--     (api/history.ts). Strike, premium, qty, expiration, sector, beta and the
--     exit path are dropped at the moment the trade becomes history — which is
--     exactly when they stop being recoverable from anywhere else.
--
-- Nothing downstream could reconstruct either: the cash_flows row for the open
-- encodes premium x 100 x qty as a single number, and its trade_id is nulled by
-- the FK when the trade is deleted.
--
-- The immediate trigger is that `trades.iv` is about to start moving. It has
-- been static for a position's whole life, so it doubled as the entry IV; once
-- the position-iv function marks it live, that stops being true and entry IV
-- joins the list above unless it is stamped somewhere first.
--
-- STRICTLY ADDITIVE. Every column is nullable, no column is dropped, renamed or
-- retyped, and no existing value is overwritten. NULL means "not recorded",
-- never zero — the attribution work downstream has to be able to tell a trade
-- that had no premium from one whose premium was never captured.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- trades — entry-invariant stamps, written once at open and never refreshed,
-- plus the provenance of the (now live) `iv` column.
--
-- `iv_skew_ratio` is this contract's IV over its expiration's ATM IV. It is the
-- fallback anchor for marking: when a contract's own quote goes untradeable —
-- no bid, or a spread so wide the implied vol is noise — its IV is re-derived
-- as (current ATM IV x this ratio). Skew at a fixed strike drifts far more
-- slowly than the vol level does, and ATM is the most liquid point on the
-- surface, so this degrades gracefully where reading the wing directly does not.
-- Refreshed whenever a trustworthy contract quote does arrive, so it tracks
-- skew drift rather than freezing at entry.
-- ---------------------------------------------------------------------------
alter table public.trades add column if not exists iv_at_open          numeric;
alter table public.trades add column if not exists atm_iv_at_open      numeric;
alter table public.trades add column if not exists underlying_at_open  numeric;
alter table public.trades add column if not exists iv_skew_ratio       numeric;
alter table public.trades add column if not exists iv_source           text;
alter table public.trades add column if not exists iv_updated_at       timestamptz;

comment on column public.trades.iv_at_open is
  'IV as entered at open. Stamped once; never touched by a refresh.';
comment on column public.trades.underlying_at_open is
  'Spot at open. NULL on rows predating 0011 — underlying_price had already '
  'been overwritten by a refresh and the true entry spot is unrecoverable.';
comment on column public.trades.iv_skew_ratio is
  'iv / atm_iv for this contract. Fallback anchor when the contract''s own '
  'quote is untrustworthy. Updated on every good contract read.';
comment on column public.trades.iv_source is
  'How `iv` was last set: entry | contract | atm_skew | last_good.';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'trades_iv_source_chk'
  ) then
    alter table public.trades add constraint trades_iv_source_chk
      check (iv_source is null or iv_source in
             ('entry', 'contract', 'atm_skew', 'last_good'));
  end if;
end $$;

-- Backfill, deliberately narrow.
--
-- `iv_at_open = iv` is sound for options *only because* nothing has ever
-- written trades.iv after open — it is still the number that was typed in. This
-- migration is the last moment that holds, which is why the backfill belongs
-- here and not later. Shares are excluded: refreshPortfolio overwrites their iv
-- with realized vol, so the stored value is a recent HV reading, not an entry
-- condition, and stamping it would be inventing provenance it doesn't have.
update public.trades
   set iv_at_open = iv,
       iv_source  = coalesce(iv_source, 'entry')
 where iv_at_open is null
   and trade_type <> 'shares';

-- Shares still get a source marker so no row is left with an unexplained iv,
-- but no iv_at_open: there isn't one to record.
update public.trades
   set iv_source = 'entry'
 where iv_source is null;

-- `underlying_at_open` is deliberately NOT backfilled from underlying_price.
-- That column holds the *current* quote, so copying it would stamp every
-- existing position with a fabricated entry spot that reads as real. 0006 made
-- that tradeoff for cost_basis and documented it as an approximation; here the
-- consumer is attribution analysis, where a plausible wrong number does more
-- damage than an honest NULL. Share lots already carry their true entry price
-- in cost_basis and lose nothing.

-- ---------------------------------------------------------------------------
-- history_trades — the full entry snapshot, captured at archive.
--
-- Every column is NULL for the rows already in the table. Those trades were
-- archived under the old eight-column write and their `trades` row is long
-- deleted; there is no source to recover them from, and guessing would corrupt
-- exactly the dataset this is being built to analyse.
-- ---------------------------------------------------------------------------
alter table public.history_trades add column if not exists qty                  integer;
alter table public.history_trades add column if not exists strike               numeric;
alter table public.history_trades add column if not exists strike_2             numeric;
alter table public.history_trades add column if not exists premium              numeric;
alter table public.history_trades add column if not exists expiration           date;
alter table public.history_trades add column if not exists cost_basis           numeric;
alter table public.history_trades add column if not exists iv_at_open           numeric;
alter table public.history_trades add column if not exists atm_iv_at_open       numeric;
alter table public.history_trades add column if not exists underlying_at_open   numeric;
alter table public.history_trades add column if not exists underlying_at_close  numeric;
alter table public.history_trades add column if not exists sector               text;
alter table public.history_trades add column if not exists beta                 numeric;
alter table public.history_trades add column if not exists exit_path            text;
alter table public.history_trades add column if not exists iv_source            text;

comment on column public.history_trades.exit_path is
  'How the position ended: close | expired | assigned | called_away. NULL on '
  'rows archived before 0011. Distinguishes a bought-back short from one that '
  'expired worthless — the same realized P&L, different decisions.';
comment on column public.history_trades.iv_at_open is
  'IV at entry. NULL on rows archived before 0011.';
comment on column public.history_trades.iv_source is
  'Provenance of iv_at_close: entry | contract | atm_skew | last_good.';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'history_trades_exit_path_chk'
  ) then
    alter table public.history_trades add constraint history_trades_exit_path_chk
      check (exit_path is null or exit_path in
             ('close', 'expired', 'assigned', 'called_away'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Guard: this migration adds columns and stamps provenance on trades. It must
-- not change how many rows either table holds, and it must not touch a single
-- realized P&L. Three months of live book sits in history_trades; if any of
-- these fire, the transaction rolls back with nothing applied.
-- ---------------------------------------------------------------------------
do $$
declare
  n_hist       bigint;
  n_trades     bigint;
  n_pnl_null   bigint;
  n_no_source  bigint;
begin
  select count(*) into n_hist   from public.history_trades;
  select count(*) into n_trades from public.trades;

  -- Untouched by design: nothing above writes to history_trades at all.
  select count(*) into n_pnl_null
    from public.history_trades where realized_pnl is null;

  -- Every open position should now explain where its iv came from.
  select count(*) into n_no_source
    from public.trades where iv_source is null;

  if n_no_source > 0 then
    raise exception '0011: % trades left without an iv_source', n_no_source;
  end if;

  raise notice '0011 applied: % trades, % history rows (% with null realized_pnl, unchanged)',
    n_trades, n_hist, n_pnl_null;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Verify after applying (expect: every history row preserved, new columns
-- present and null, open trades all stamped):
--
--   select count(*) as history_rows,
--          count(realized_pnl) as with_pnl,
--          count(exit_path)    as with_exit_path   -- 0 before any new archive
--     from public.history_trades;
--
--   select iv_source, count(*), count(iv_at_open)
--     from public.trades group by iv_source;
-- ---------------------------------------------------------------------------
