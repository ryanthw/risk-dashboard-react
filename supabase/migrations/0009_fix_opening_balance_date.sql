-- ============================================================================
-- 0009 — date the opening balance before the snapshot history
--
-- 0008 seeded each portfolio's opening_balance at portfolios.created_at, on the
-- assumption that a portfolio row always predates its own snapshots. It does
-- not: recordSnapshot normalizes every snapshot to 16:00 UTC, so a portfolio
-- created any later in the day than that gets a first snapshot stamped hours
-- before the row itself existed. Observed at 16:00:00 vs a created_at of
-- 19:11 on the same day.
--
-- When the seed lands inside the snapshot range it behaves as a deposit, and
-- since opening_balance is an external flow, TWR subtracts the entire starting
-- capital from the return of whichever period contains it. Against a first
-- observation of a few hundred dollars that is enough to turn a real gain into
-- a large apparent loss.
--
-- The opening balance is the capital base the series starts from, so it belongs
-- strictly before the first observation. Any reconciling adjustment written
-- alongside it moves too — internal flows do not affect TWR, but keeping the
-- pair together stops the ledger reading as though something happened mid-series.
-- ============================================================================

update public.cash_flows cf
   set ts = first.ts - interval '1 day'
  from (
    select portfolio_id, min(ts) as ts
      from public.history_snapshots
     group by portfolio_id
  ) as first
 where cf.portfolio_id = first.portfolio_id
   and cf.kind in ('opening_balance', 'adjustment')
   and cf.ts >= first.ts;
