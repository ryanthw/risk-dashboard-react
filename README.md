# Risk Dashboard (React)

A professional, dark-themed **options & equity risk management** dashboard — a
ground-up React/TypeScript rewrite of the original Streamlit app (kept for
reference in `Risk Dashboard Final/`).

Multi-portfolio tracking, a full TypeScript financial engine (Black-Scholes,
Monte-Carlo POP/VaR/CVaR/Kelly, finite-difference Greeks), institutional risk
analytics, interactive Plotly visuals, a trade sandbox, and a wheel-strategy
scanner — all on a free Supabase + Vercel stack with per-account data isolation.

---

## Research boundary

Strategy research lives in a **separate private repo** and is not part of this one.
The relationship is one-way:

```
  research (private)  --->  Supabase tables  --->  this dashboard
                                                   READ ONLY
```

`earnings_reliability` and `income_universe` are populated only from the research
side. This repo owns their schema and a `select`-only RLS policy, and contains no
`insert`, `update`, `upsert`, or `delete` against either — the Earnings and Income
scanners read them and nothing more. If you are changing the data layer, keep it
that way; this check should return nothing:

```sh
grep -rnE '\.from\(\s*.(earnings_reliability|income_universe).\s*\)\s*\.\s*(insert|upsert|update|delete)' src supabase scripts
```

**Self-hosting:** the migrations create those two tables empty. Everything else
works out of the box; the Earnings and Income scanners return nothing until you
populate them with your own data.

## Tech Stack

- **Vite + React 18 + TypeScript**
- **Tailwind CSS** + shadcn-style Radix UI primitives (custom dark theme)
- **Plotly.js** (lazy-loaded) for financial charts
- **TanStack Query** for server-state caching, **Zustand** for UI state
- **Supabase** — Postgres, Auth (email/password), Edge Functions, Row Level Security
- **Finnhub + Yahoo Finance** market data, proxied through an Edge Function

---

## Architecture

```
src/
  engine/      Financial engine (ported 1:1 from the Python app)
    blackScholes.ts   normCdf, BS pricing, theoretical value, Greeks
    monteCarlo.ts     GBM simulation, payoffs, POP/EV/VaR/CVaR/Kelly
    trade.ts          per-trade metrics (value, max gain/loss, DTE)
    portfolio.ts      portfolio math (exposure, HHI, net liq, beta-delta…)
  api/         Supabase data hooks (portfolios, trades, history, market data)
  hooks/       usePositions, useActivePortfolio, useRefreshMarketData
  components/  ui/ (primitives) · layout/ · charts/ · trades/ · strategy/
  pages/       Login · Dashboard · Visuals · Strategy · History · TradeAnalysis
supabase/
  migrations/0001_init.sql      schema + RLS (run once)
  functions/market-data/        Deno edge function (Finnhub + Yahoo proxy)
```

The original stored each position as a Python `pickle` blob; this version uses
**structured columns** and reimplements the entire quant engine in TypeScript, so
all analytics run client-side with no server compute.

---

## Local Development

```bash
npm install
cp .env.example .env.local   # fill in your Supabase URL + anon key
npm run dev                  # http://localhost:5173
```

Without Supabase keys the app still boots (Login renders) and shows a
"not configured" banner.

Useful scripts: `npm run build` · `npm run typecheck` · `npm run preview`.

---

## Backend Setup (Supabase — free tier)

1. **Create a project** at [supabase.com](https://supabase.com) (free tier).
2. **Run the schema.** Open *SQL Editor → New query*, paste the contents of
   `supabase/migrations/0001_init.sql`, and run it. This creates all tables,
   triggers, and Row Level Security policies (`user_id = auth.uid()` — every
   account only ever sees its own data).
3. **Grab your keys** from *Project Settings → API* and put them in `.env.local`:
   ```
   VITE_SUPABASE_URL=https://YOUR_REF.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-public-key
   ```
   The anon key is safe to ship to the browser — RLS enforces isolation.
4. **Auth options** (*Authentication → Providers → Email*): for quick testing you
   can disable "Confirm email"; for production leave it on.

### Deploy the market-data Edge Function

```bash
npm i -g supabase
supabase login
supabase link --project-ref YOUR_REF
supabase functions deploy market-data
supabase secrets set FINNHUB_API_KEY=your_finnhub_key   # free at finnhub.io
```

The function proxies Finnhub (price/sector/beta) and Yahoo Finance (historical
candles → volatility & correlation), keeping the API key server-side and avoiding
browser CORS. It requires a valid Supabase JWT, so only logged-in users can call it.

> If you skip this step the app fully works with **manually entered** prices/IV;
> only the live "fetch" button, correlation heatmap, and scanner stay idle.

---

## Free Hosting (Frontend — Vercel)

1. Push this folder to a Git repo.
2. Import it at [vercel.com](https://vercel.com) → it auto-detects Vite
   (`vercel.json` is already configured with the SPA rewrite).
3. Add Environment Variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Deploy. Every push redeploys automatically.

**Cost: $0/month.** Vercel Hobby (frontend) + Supabase Free (DB/auth/edge functions)
+ Finnhub free key + Yahoo. Alternatives for the frontend: Cloudflare Pages or
Netlify (same Vite static build).

> Note: a Supabase free project pauses after ~7 days of inactivity — one visit
> resumes it.

---

## Features

- **Dashboard** — Big-5 metrics (Total Value, Gross Exposure, Net Liquidity, HHI,
  Open Trades), full risk panel (leverage, alpha multipliers, ERPA), and trade
  CRUD with edit / archive-to-history / hard-delete.
- **Visuals** — risk-reward scatter, capital-at-risk by expiration, allocation
  donut, aggregated Monte-Carlo P&L distribution, price×vol stress-test heatmap,
  30-day Greek decay, 10-year wealth forecast.
- **Strategy** — anti-correlation score, beta-weighted delta, sector treemap,
  capital-by-strategy, ticker allocation guard (>10% alerts), income-factory
  fulfillment, correlation heatmap, wheel-strategy opportunity scanner.
- **History** — net-liquidity over time, closed-trade ledger with realized P&L.
- **Trade Analysis** — sandbox with live EV/POP/VaR/CVaR/Kelly/Greeks, payoff
  diagram with lognormal price-probability overlay, and portfolio-impact analysis.

---

## Security notes

- The Supabase **anon** key ships in the client bundle by design. Every table has
  RLS enabled; user data is scoped to `auth.uid()`, and shared reference tables are
  readable by `authenticated` only, never `anon`.
- `FINNHUB_API_KEY`, `PUBLI_API_KEY` and `PUBLIC_ACCOUNT_ID` are Edge Function
  secrets and never reach the client. `PUBLIC_ACCOUNT_ID` identifies a real
  brokerage account — keep it configuration, never a literal.
- The scheduled snapshot job runs from a private repo, because it authenticates as
  a real account with an email and password. `npm run snapshot:local` is the local
  equivalent for your own account.

## Notes / Future Work

- The Plotly bundle (~1.4 MB gzip) is lazy-loaded into its own async chunk; a
  custom partial Plotly build could shrink it further.
- Heavy aggregate Monte-Carlo runs could be moved into a Web Worker if portfolios
  grow very large (currently fast for typical sizes).
- Delta heuristics in `portfolio.ts` use fixed per-strategy approximations,
  matching the original app; these could be replaced with exact BS deltas.
