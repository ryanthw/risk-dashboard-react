-- ============================================================================
-- 0010_trade_cash_corrections — keep the ledger honest when a trade is
-- corrected or was never real
--
-- 0008 automated the cash a trade moves at open, but only on create. Two paths
-- could then walk the balance away from reality with nothing to show for it:
--
--   * Hard Delete removed the position and left its trade_open flow behind, so
--     the balance kept premium that was never collected and the row pointed at
--     a trade that no longer existed (trade_id nulled by the FK).
--   * Editing qty/premium/cost basis rewrote the position but never the flow,
--     so a mis-keyed premium stayed mis-keyed in cash — silently, with no
--     deleted position to hint that anything had happened.
--
-- Both are corrections of a *mis-entry*, not events in the portfolio's life, so
-- neither leaves a compensating row behind. A reversal row would settle the
-- balance while still reading as something the portfolio did; instead the
-- original row is rewritten or removed and the balance moved with it, in one
-- transaction, so sum(cash_flows) = portfolios.cash continues to hold.
--
-- Archiving is deliberately untouched: there the cash genuinely moved, and both
-- the opening and closing flows stay on the books.
--
-- security invoker on both, so RLS still decides which rows a caller can touch.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- delete_trade_cash — unwind everything a trade booked. Returns the net amount
-- removed, so the caller can report what the balance did.
--
-- Must be called *before* the trade row is deleted: the FK nulls trade_id on
-- delete and the rows become unfindable. Calling it twice is safe — the second
-- call matches nothing and returns 0 — which is what makes it correct to run
-- first and delete the trade second.
-- ---------------------------------------------------------------------------
create or replace function public.delete_trade_cash(
  p_trade_id     uuid,
  p_portfolio_id uuid
)
returns numeric
language plpgsql
security invoker
as $$
declare
  v_total numeric;
begin
  with removed as (
    delete from public.cash_flows
     where trade_id = p_trade_id
       and portfolio_id = p_portfolio_id
    returning amount
  )
  select coalesce(sum(amount), 0) into v_total from removed;

  if v_total <> 0 then
    update public.portfolios
       set cash = cash - v_total
     where id = p_portfolio_id;
  end if;

  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- adjust_trade_open_cash — restate a trade's opening flow in place after an
-- edit. Returns the delta actually applied to the balance.
--
-- Takes the *change* in entry cost rather than the new absolute amount, because
-- for a shares lot those are not the same number. Assignment merges delivered
-- stock into the existing lot at a blended basis (see applySharesDelta), so
-- basis x qty on a merged lot covers cash that the `assignment` flow already
-- booked. Restating to the absolute would count those dollars twice; applying
-- the difference leaves untouched fields alone and cannot.
--
-- The presence of a trade_open row is what marks a trade's opening cash as
-- ledger-managed. Trades that predate the ledger have none — their cash is
-- folded into the seeded opening_balance — and neither do lots created by
-- assignment, whose cash arrived as an `assignment` flow. Both are left alone
-- and the function returns 0.
-- ---------------------------------------------------------------------------
create or replace function public.adjust_trade_open_cash(
  p_trade_id     uuid,
  p_portfolio_id uuid,
  p_delta        numeric,
  p_ts           timestamptz default null
)
returns numeric
language plpgsql
security invoker
as $$
declare
  v_count integer;
begin
  update public.cash_flows
     set amount = amount + p_delta,
         ts     = coalesce(p_ts, ts)
   where id = (
     select id
       from public.cash_flows
      where trade_id = p_trade_id
        and portfolio_id = p_portfolio_id
        and kind = 'trade_open'
      order by ts asc
      limit 1
   );

  get diagnostics v_count = row_count;
  if v_count = 0 then
    return 0;
  end if;

  if p_delta <> 0 then
    update public.portfolios
       set cash = cash + p_delta
     where id = p_portfolio_id;
  end if;

  return p_delta;
end;
$$;
