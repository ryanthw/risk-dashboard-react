# Risk Dashboard — React Port: Architecture & Build Plan

A ground-up React rewrite of the Streamlit options/stock risk dashboard
(`Risk Dashboard Final/`). Goal: same (or improved) functionality, a
professional-grade sleek dark UI, a brand-new Supabase backend, and free hosting.

---

## 1. Tech Stack

| Concern        | Choice | Why |
|----------------|--------|-----|
| Build tool     | **Vite** + React 18 + TypeScript | Fast, static SPA output, ideal for Vercel |
| Styling        | **Tailwind CSS v3** + custom dark design tokens | Sleek, consistent, dark-native |
| UI primitives  | **shadcn/ui** (Radix + Tailwind) | Accessible Dialog/Popover/Select/Tabs — matches the Streamlit popovers/expanders |
| Icons          | **lucide-react** | Clean modern icon set |
| Charts         | **react-plotly.js** (lazy-loaded) | 1:1 match for payoff diagrams, distplots, heatmaps, treemaps, correlation |
| Data fetching  | **TanStack Query** | Mirrors Streamlit's `st.cache_data(ttl=600)` caching model |
| Local state    | **Zustand** (active portfolio) + Auth context | Lightweight |
| Routing        | **React Router v6** | Multi-page structure like `pages/` |
| Forms          | **react-hook-form** + **zod** | Typed validation for trade entry |
| Backend        | **Supabase** (Postgres + Auth + Edge Functions) | Free tier covers everything |
| Market data    | **Supabase Edge Function** proxying Finnhub + Yahoo | Hides key, dodges CORS, replaces yfinance |

---

## 2. Folder Structure

```
Risk Dashboard React/
├── Risk Dashboard Final/          # original Streamlit app (reference; deletable later)
├── PLAN.md  README.md  .env.example  .gitignore
├── index.html  package.json  tsconfig.json  vite.config.ts
├── tailwind.config.ts  postcss.config.js  components.json
├── supabase/
│   ├── migrations/0001_init.sql   # schema + RLS + indexes
│   └── functions/market-data/index.ts   # Deno edge function
└── src/
    ├── main.tsx  App.tsx  index.css
    ├── lib/         supabase.ts · queryClient.ts · format.ts · cn.ts
    ├── types/       index.ts        # Trade, Portfolio, Snapshot, enums
    ├── engine/      # FINANCIAL ENGINE ported from trade.py + utils.py
    │   ├── blackScholes.ts          # normCdf, bsPrice, theoreticalValue, greeks
    │   ├── monteCarlo.ts            # GBM sim, payoff, POP, EV, VaR, CVaR, Kelly
    │   ├── trade.ts                 # deriveTradeMetrics() — all per-trade stats
    │   └── portfolio.ts             # exposure, HHI, net liq, beta-delta, ER, etc.
    ├── api/         marketData.ts · portfolios.ts · trades.ts · history.ts · snapshots.ts
    ├── store/       auth.tsx · portfolio.ts
    ├── components/
    │   ├── ui/        button card dialog input select tabs popover metric badge progress
    │   ├── layout/    AppShell · Sidebar · TopBar
    │   ├── charts/    PlotlyChart (themed wrapper) + chart components
    │   └── trades/    TradeCard · AddTradeForm · EditTradeDialog · CloseTradeDialog
    └── pages/       Login · Dashboard · Visuals · Strategy · History · TradeAnalysis
```

---

## 3. Database Schema (new Supabase project)

Key improvement over the original: **drop the Python `pickle` blob**. Trades become
fully structured, queryable rows. Portfolios referenced by **UUID FK**, not name string.
All derived analytics (Greeks, POP, VaR, payoff) are recomputed in TypeScript on the client.

```sql
-- profiles (1:1 with auth.users, optional display data)
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  cash numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  trade_type text not null check (trade_type in
    ('shares','csp','cc','short_call','short_put','long_call',
     'long_put','pcs','ccs','cds','pds')),
  ticker text not null,
  qty integer not null default 1,
  strike numeric, strike_2 numeric, premium numeric,
  iv numeric not null default 0.30,
  expiration date,
  underlying_price numeric,
  sector text default 'Unknown',
  beta numeric default 1.0,
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table history_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid references portfolios(id) on delete set null,
  ticker text, trade_type text,
  entry_date timestamptz, exit_date timestamptz,
  realized_pnl numeric, iv_at_close numeric,
  max_loss numeric, final_value numeric,
  created_at timestamptz not null default now()
);

create table history_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  ts timestamptz not null default now(),
  net_liquidity numeric, weighted_delta numeric,
  expected_profit_total numeric, erpa numeric
);
-- one snapshot per portfolio per calendar day
create unique index history_snapshots_one_per_day
  on history_snapshots (portfolio_id, (ts::date));
```

### Auth + per-user isolation ("account-based login and schemas")
- **Supabase Auth** email/password (sign up / log in / log out), session persisted in
  `localStorage` with auto-refresh.
- **Row Level Security** on every table with policy `user_id = auth.uid()` for
  select/insert/update/delete. This is the idiomatic Supabase multi-tenant pattern —
  each account only ever sees its own portfolios/trades/history. (True separate Postgres
  schemas per user aren't needed and don't scale; RLS is the correct "account-based
  schema" approach.)
- A trigger auto-creates a `profiles` row on signup.

---

## 4. Financial Engine (ported to TypeScript, 1:1 fidelity)

`engine/blackScholes.ts`
- `normCdf(x)` — Abramowitz-Stegun / erf approximation (replaces `scipy.stats.norm`).
- `bsPrice(S,K,T,sigma,r,type)` — exact port of `_bs_price`.
- `theoreticalValue(trade, {S,T,iv,r})` — port of `get_theoretical_value` (all 11 types).
- `greeks(trade)` — finite-difference delta/theta/vega, identical shifts (1% S, 1% vol, 1 day).

`engine/monteCarlo.ts`
- `gaussianPair()` Box-Muller; antithetic variates (`[Z, -Z]`) exactly like NumPy version.
- `simulatePayoff(trade, sims, mu)` → terminal P&L array via GBM.
- `payoffAtPrices(trade, ST[])` — full payoff logic for every strategy.
- `pop / expectedProfit / var95 / cvar95 / kelly` (Half-Kelly).
- Default 50k sims (tunable); aggregated portfolio distribution computed in a **Web Worker**
  to keep the UI responsive.

`engine/trade.ts`
- `maxGain / maxLoss` per-type formulas (exact port), `value`, `dte`, `posLen`.
- `deriveTradeMetrics(trade)` returns a memoized bundle of every stat used by the UI.

`engine/portfolio.ts`
- All of `utils.py`: `grossExposure, percentExposure, cashPercent, cashToPosRatio,
  leverageRatio, highestPosPercent, hhi, maxProfit, riskRewardRatio, portExpectedReturn,
  erPercent, erAnn, netLiquidity, costToCloseShorts, longOptionsVals, undeployedCash,
  betaWeightedDelta, snapshot metrics`.

> Performance: metrics memoized per-trade (recompute only on input change). Heavy 100k+
> aggregate sims offloaded to a worker. Numbers will match the Python app within Monte
> Carlo sampling noise.

---

## 5. Market-Data Edge Function (`supabase/functions/market-data`)

Deno function, `FINNHUB_API_KEY` as a Supabase secret. Actions:
- `quote(ticker)`     → Finnhub `/quote` (current price)
- `profile(ticker)`   → Finnhub `/stock/profile2` (sector)
- `metrics(ticker)`   → Finnhub `/stock/metric?metric=all` (beta)
- `candles(ticker,n)` → Yahoo `query1.finance.yahoo.com/v8/finance/chart` (closes → HV & correlation client-side)
- CORS headers; verifies Supabase JWT so only logged-in users can call it.

Client (`api/marketData.ts`) wraps these; HV = `std(logReturns) * sqrt(252)`,
correlation matrix from aligned daily returns (replaces the yfinance/pandas logic in
`02_Strategy.py`).

---

## 6. Pages (feature parity map)

| Page | Source | Contents |
|------|--------|----------|
| **Login** | `Dashboard.py` auth_form | Email/password login + signup tabs, dark hero |
| **Dashboard** | `Dashboard.py` | Big-5 metrics (Total Value, Gross Exposure, Net Liquidity, HHI, Open Trades); Risk Analysis panel (exposure/leverage, returns, alpha multipliers); Open-trades list with Edit / Close(archive) / Hard-delete; sidebar portfolio switcher, add-trade, cash update, refresh-market-data |
| **Visuals** | `01_Visuals.py` | Risk-reward scatter, capital-at-risk bar, allocation donut, aggregated MC P&L distribution, price×vol stress-test heatmap, Greek decay lines, 10-yr wealth forecast |
| **Strategy** | `02_Strategy.py` | Anti-correlation score, beta-delta, est. theta; sector treemap; capital-by-strategy donut; ticker allocation guard (>10% alerts); income-factory fulfillment bars; correlation heatmap; wheel-strategy opportunity scanner |
| **History** | `03_History.py` | Net-liquidity-over-time line; raw snapshot table; closed-trade history table |
| **Trade Analysis** | `04_Trade_Analysis.py` | Sandbox: EV / POP / max gain-loss / VaR / CVaR / Kelly / beta-delta; payoff diagram with lognormal price-probability overlay; portfolio impact (sector shift, delta, HHI, exposure); execute-to-portfolio |

Shared: themed `PlotlyChart` wrapper (dark template, brand palette `#0971B2` primary,
`#00CC96` gain, `#8b0000`/red loss), reusable `Metric` card, loading skeletons, toasts.

---

## 7. Free Hosting

- **Frontend → Vercel.** `npm run build` → `dist/`; SPA rewrite to `index.html`;
  env vars `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Auto-deploy from Git. Free.
- **Backend → Supabase free tier.** 500 MB Postgres, unlimited auth users,
  500k edge-function calls/mo. (Note: free projects pause after ~7 days of inactivity —
  one dashboard visit resumes them.)
- **Market data** — Finnhub free key (server-side secret) + Yahoo free endpoint. Free.
- **Secrets** never shipped to the client except the Supabase *anon* key (safe by design,
  guarded by RLS).

Total recurring cost: **$0**.

---

## 8. Build Phases

0. **Scaffold** — Vite/TS, Tailwind, shadcn/ui, theme tokens, app shell, routing.
1. **Engine** — port blackScholes / monteCarlo / trade / portfolio + sanity checks vs Python.
2. **Backend** — `0001_init.sql` (schema + RLS), Supabase client, auth context, protected routes, Login page.
3. **Data layer** — TanStack Query hooks for portfolios/trades/history/snapshots; edge function + deploy.
4. **Dashboard** — Big-5 metrics, risk panel, trade CRUD (add/edit/close/delete), sidebar, refresh.
5. **Remaining pages** — Visuals, Strategy, History, Trade Analysis with all charts.
6. **Polish & deploy** — loading/error/empty states, toasts, responsive checks, README + Vercel/Supabase deploy docs.

---

## 9. What I need from you (when ready)

- New Supabase project **URL** + **anon key** (and access to add the `FINNHUB_API_KEY`
  secret + run the migration — or I'll provide exact steps/SQL to paste).
- Confirm Finnhub key to use (the existing free one is fine to start).
