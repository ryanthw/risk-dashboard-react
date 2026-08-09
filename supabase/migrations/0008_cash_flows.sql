-- ============================================================================
-- 0008_cash_flows — a cash ledger for the portfolio
--
-- Two jobs:
--   1. Automate the cash movements that were previously typed in by hand on
--      every trade open/close.
--   2. Separate *external* flows (deposits, withdrawals) from *internal* ones
--      (premium, assignment). Only external flows break the chain in a
--      time-weighted return; without the distinction, TWR reads every premium
--      collected as a contribution and the return collapses toward zero.
--
-- portfolios.cash stays the live balance. Every mutation goes through
-- record_cash_flow() so the ledger and the balance move in one transaction and
-- cannot drift.
-- ============================================================================

create table if not exists public.cash_flows (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  portfolio_id uuid not null references public.portfolios (id) on delete cascade,
  ts           timestamptz not null default now(),
  -- Signed: positive moves cash into the account, negative out.
  amount       numeric not null,
  kind         text not null check (kind in (
                 -- external: changes the capital base, breaks the TWR chain
                 'opening_balance', 'deposit', 'withdrawal',
                 -- internal: the portfolio earning or losing its own money
                 'trade_open', 'trade_close', 'assignment', 'called_away',
                 'expiry', 'dividend', 'fee', 'adjustment')),
  -- Set null rather than cascading: deleting a trade must not erase the cash
  -- that actually moved, or the balance silently stops reconciling.
  trade_id     uuid references public.trades (id) on delete set null,
  ticker       text,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists cash_flows_portfolio_ts_idx
  on public.cash_flows (portfolio_id, ts);
create index if not exists cash_flows_user_idx on public.cash_flows (user_id);

alter table public.cash_flows enable row level security;

drop policy if exists "cash_flows owner" on public.cash_flows;
create policy "cash_flows owner" on public.cash_flows
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- record_cash_flow — the only supported way to move cash.
--
-- security invoker so RLS still applies: a caller can only write rows for, and
-- adjust the balance of, a portfolio they own. The insert and the balance
-- update share one transaction, so a failure leaves neither behind.
-- ---------------------------------------------------------------------------
create or replace function public.record_cash_flow(
  p_portfolio_id uuid,
  p_amount       numeric,
  p_kind         text,
  p_trade_id     uuid        default null,
  p_ticker       text        default null,
  p_note         text        default null,
  p_ts           timestamptz default now()
)
returns public.cash_flows
language plpgsql
security invoker
as $$
declare
  v_row public.cash_flows;
begin
  insert into public.cash_flows
    (user_id, portfolio_id, ts, amount, kind, trade_id, ticker, note)
  values
    (auth.uid(), p_portfolio_id, p_ts, p_amount, p_kind, p_trade_id, p_ticker, p_note)
  returning * into v_row;

  update public.portfolios
     set cash = cash + p_amount
   where id = p_portfolio_id;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill: seed each existing portfolio with an opening balance equal to the
-- cash it holds today, so sum(cash_flows.amount) = portfolios.cash from here
-- on. Dated to the portfolio's creation so it precedes every snapshot and does
-- not register as a contribution partway through the return series.
-- ---------------------------------------------------------------------------
insert into public.cash_flows (user_id, portfolio_id, ts, amount, kind, note)
select p.user_id, p.id, p.created_at, p.cash, 'opening_balance',
       'Seeded from portfolios.cash when the ledger was introduced'
  from public.portfolios p
 where p.cash <> 0
   and not exists (
     select 1 from public.cash_flows cf
      where cf.portfolio_id = p.id and cf.kind = 'opening_balance'
   );
