-- ============================================================================
-- Risk Dashboard — initial schema
-- Run in the Supabase SQL editor (Dashboard -> SQL -> New query) or via
--   supabase db push
-- Every table is isolated per account via Row Level Security (user_id = auth.uid()).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles: 1:1 with auth.users (optional display metadata)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at  timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- portfolios
-- ---------------------------------------------------------------------------
create table if not exists public.portfolios (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  cash        numeric not null default 0,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);
create index if not exists portfolios_user_idx on public.portfolios (user_id);

-- ---------------------------------------------------------------------------
-- trades (active positions) — structured columns, no pickle blob
-- ---------------------------------------------------------------------------
create table if not exists public.trades (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  portfolio_id     uuid not null references public.portfolios (id) on delete cascade,
  trade_type       text not null check (trade_type in
                     ('shares','csp','cc','short_call','short_put','long_call',
                      'long_put','pcs','ccs','cds','pds')),
  ticker           text not null,
  qty              integer not null default 1,
  strike           numeric,
  strike_2         numeric,
  premium          numeric,
  iv               numeric not null default 0.30,
  expiration       date,
  underlying_price numeric,
  sector           text default 'Unknown',
  beta             numeric default 1.0,
  opened_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists trades_portfolio_idx on public.trades (portfolio_id);
create index if not exists trades_user_idx on public.trades (user_id);

-- keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trades_touch on public.trades;
create trigger trades_touch before update on public.trades
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- history_trades (archived/closed positions)
-- ---------------------------------------------------------------------------
create table if not exists public.history_trades (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  portfolio_id  uuid references public.portfolios (id) on delete set null,
  ticker        text,
  trade_type    text,
  entry_date    timestamptz,
  exit_date     timestamptz,
  realized_pnl  numeric,
  iv_at_close   numeric,
  max_loss      numeric,
  final_value   numeric,
  created_at    timestamptz not null default now()
);
create index if not exists history_trades_portfolio_idx on public.history_trades (portfolio_id);

-- ---------------------------------------------------------------------------
-- history_snapshots (daily portfolio metric logs)
-- ---------------------------------------------------------------------------
create table if not exists public.history_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  portfolio_id          uuid not null references public.portfolios (id) on delete cascade,
  ts                    timestamptz not null default now(),
  net_liquidity         numeric,
  weighted_delta        numeric,
  expected_profit_total numeric,
  erpa                  numeric
);
-- one snapshot per portfolio per calendar day
create unique index if not exists history_snapshots_one_per_day
  on public.history_snapshots (portfolio_id, ((ts at time zone 'UTC')::date));

-- ============================================================================
-- Row Level Security — each account sees only its own rows
-- ============================================================================
alter table public.profiles          enable row level security;
alter table public.portfolios        enable row level security;
alter table public.trades            enable row level security;
alter table public.history_trades    enable row level security;
alter table public.history_snapshots enable row level security;

-- profiles
drop policy if exists "profiles self" on public.profiles;
create policy "profiles self" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- portfolios
drop policy if exists "portfolios owner" on public.portfolios;
create policy "portfolios owner" on public.portfolios
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- trades
drop policy if exists "trades owner" on public.trades;
create policy "trades owner" on public.trades
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- history_trades
drop policy if exists "history_trades owner" on public.history_trades;
create policy "history_trades owner" on public.history_trades
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- history_snapshots
drop policy if exists "history_snapshots owner" on public.history_snapshots;
create policy "history_snapshots owner" on public.history_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
