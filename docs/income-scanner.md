# Income Scanner

A cash-secured-put (CSP) opportunity finder for the income-driver sleeve of the
book. It sweeps a curated universe of liquid, low-priced names and ranks the best
put-selling candidates by vol-risk premium, annualized yield, and how well each
name diversifies the current portfolio.

## How it works

The expensive work (fetching option chains) is **decoupled from your click** —
a "producer" computes everything server-side and caches it; the page just reads
the cache and does cheap filtering/ranking.

```
  producer (edge fn) ──► CBOE chains + Yahoo HV + Finnhub earnings
                     ──► income_scan_cache (one JSON payload, 15-min TTL)

  Income Scanner page ──► read cache ──► filter <$15 spot, IV/HV≥0.8,
                                          drop earnings, pick Δ/DTE, rank ──► top 20
```

### Pieces

| Piece | Path |
|---|---|
| Universe table + cache table + seed | `supabase/migrations/0005_income_scanner.sql` |
| Producer (edge function) | `supabase/functions/income-scanner/index.ts` |
| Client API + ranking logic | `src/api/income.ts` (`rankCandidates`) |
| UI panel (sliders, table, deep-link) | `src/components/income/IncomeScannerPanel.tsx` |
| Page + sector-weight wiring | `src/pages/IncomeScanner.tsx` |

### What the producer caches

Per name: spot, annualized HV, sector, beta, next earnings date, and the **put
chain band** (strikes with |Δ| 0.05–0.45 across 5–65 DTE) with greeks. Because
the full band is cached, the **Δ and DTE sliders re-pick strikes client-side with
no re-fetch** — they're instant.

### Ranking (client-side, in `rankCandidates`)

1. Drop names with spot ≥ the max-price field (default $15).
2. Pick the expiration nearest the target DTE; drop if earnings land on/before it.
3. Pick the put nearest the target delta; require `vol + oi ≥ 50`.
4. Drop if `IV/HV < 0.8` (realized vol badly outrunning implied = underpaid).
5. Score = `(IV/HV) × annualizedROC × (1 − currentSectorWeight)`, take top 20.

`annualizedROC = (credit / strike) × (365 / DTE)` — yield on the cash collateral.

## Refresh model (current: lazy cache)

The producer recomputes **on the first request after the cache passes its 15-min
TTL** (a ~5–10s wait for that one caller); everyone else gets the cache instantly.
The **Refresh** button forces an immediate live recompute (`force: true`). The
15-min TTL is deliberate — CBOE's quotes are themselves ~15 min delayed, so
refetching faster gains nothing.

## Upgrade path: true 15-min cron (always-instant loads)

To remove even the occasional cold-scan wait, run the producer on a schedule so
the cache is refreshed in the background and every page load is instant.

### Option A — `pg_cron` + `pg_net` (in-database, no external infra)

```sql
-- one-time setup
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- invoke the edge function every 15 minutes
select cron.schedule(
  'income-scanner-refresh',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/income-scanner',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer <SERVICE_ROLE_KEY>'),
    body    := jsonb_build_object('force', true)
  );
  $$
);
```

Store the service-role key via Vault rather than inlining it in production. To
remove later: `select cron.unschedule('income-scanner-refresh');`.

### Option B — Supabase Scheduled Functions / external cron

Use the dashboard's scheduled-functions (cron trigger) feature, or any external
scheduler (GitHub Actions, Vercel Cron, etc.) to `POST {"force": true}` to the
function URL every 15 minutes with the service-role bearer token.

### Client change (optional)

With a cron in place the UI needs no change — it already reads the cache. If you
want, drop the client `staleTime` so navigation always re-reads the freshest
cached payload (still no live fetch on the request path).

## Tuning the universe

`income_universe` is a plain table. Add/remove names or flip `active`:

```sql
insert into public.income_universe (ticker, sector, beta)
values ('XYZ', 'Technology', 1.8)
on conflict (ticker) do update set active = true;

update public.income_universe set active = false where ticker = 'ABC';
```

Keep `sector` aligned with Finnhub's `finnhubIndustry` labels (what `market-data`
stamps on portfolio trades) so the diversification rating matches your book.

## Possible next steps

- Split HV into a once-daily refresh so the 15-min producer only refetches the
  fast-moving CBOE chains (faster cold scans).
- Add an IV-rank signal (needs per-name 1yr IV history) as an alternative to IV/HV.
- Surface assignment-adjusted yield (yield if assigned vs. expired) per row.
