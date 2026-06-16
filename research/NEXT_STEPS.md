# Next Steps — Strategy Research for Smaller Accounts

Context: the earnings short-iron-butterfly scanner is built and viable, but it's a
**diversification- and execution-heavy** strategy that really wants ~$15–25k+ to run as
designed (see `REPORT.md` §"reality for small accounts"). These are the research paths that fit
*smaller* accounts better — and most reuse the infrastructure already built (earnings calendar,
DoltHub option history, CBOE live chains, reliability cache, scanner tab).

> **STATUS (2026-06-15):** Two paths backtested on real data — see `SMALL_ACCOUNT_FINDINGS.md`.
> - **PEAD (#1):** gross edge validated and exactly literature-shaped, but **after Corwin-Schultz
>   bid-ask cost it survives only as a 20-day hold on the biggest-surprise, lowest-liquidity names
>   (~+0.37%/trade, t≈2.3).** Marginal but tradeable. Recommended next build: scanner mode with a
>   net-of-spread column. Scripts: `pead.py`, `pead_cost.py`.
> - **Credit spreads (#5):** naive weekly SPY bull-put/bear-call held to expiry has **NO edge**
>   (80% win but PF 0.88, negative since 2021). Open: test 50%-profit/21-DTE management (needs an
>   exit-chain pull). Script: `credit_spreads.py`.
> - **Landscape:** FINRA's PDT rule was eliminated 2026-06-04 ($2k min, risk-based margin) — the
>   "hold overnight to dodge PDT under $25k" rationale below no longer binds.

## What makes a strategy small-account friendly
The inverse of the iron butterfly's pain points:
- **Low capital per trade** (ideally fractional-share-able → works at any dollar amount).
- **Few legs / liquid instruments** → minimal bid-ask slippage.
- **Doesn't need 15–40 concurrent positions** to control variance.
- **Held overnight or longer** → the US PDT rule (under $25k) never bites.
- **$0-commission compatible** (Robinhood) → no per-contract drag at small size.
- **Researchable with our stack**: yfinance (prices, earnings dates + EPS surprise), DoltHub
  (historical EOD option chains + IV), CBOE (live chains), Finnhub (calendar).

---

## Ranked research paths

### 1. Post-Earnings Announcement Drift (PEAD) — top pick, data already on disk
Stocks that beat/miss tend to **drift in the surprise direction for days–weeks** after the print.
- **Why it fits:** directional equity (or simple long calls) → fractional shares at *any* size,
  one position, negligible slippage on liquid names, held overnight (no PDT), $0 commission.
- **Researchable now:** `earnings_dates.parquet` already has EPS `Surprise(%)`, and we have prices
  for ~1,765 tickers. No new data pull needed.
- **The angle:** PEAD is partly arbitraged in large caps but **persists in smaller, less-covered
  names** — exactly what a small account can trade and institutions ignore.
- **First backtest:** surprise direction → forward 1/5/20-day returns, bucketed by surprise
  magnitude and market cap / liquidity. Confirm the drift still exists before building.
- **Product fit:** a second scanner mode — "ride the drift *after* earnings" alongside the
  existing "sell premium *into* earnings."

### 2. Pre-earnings IV ramp (long vol, exit BEFORE the print)
Buy a straddle/calls ~5–10 days out, sell the **day before earnings** — capture the IV run-up,
take **zero event risk** (out before the crush).
- **Why it fits:** long premium = defined small cost, no margin, no diversification requirement.
- **Researchable:** DoltHub IV history (same pipeline as the scanner). Mirror image of the current
  tool — same names, opposite timing.
- **Caveat:** the IV ramp must outpace theta decay; only works on the right names/timing — must be
  validated, not assumed.

### 3. "Cheap vol" inverse screen (quick win, ~20 min)
We found implied > actual **82%** of the time → ~18% are *underpriced*. Test whether a long
straddle on the cheapest-implied-vs-history subset has positive EV.
- **Why it fits:** defined premium cost (small-account friendly).
- **Researchable instantly:** reanalyze `trades_enriched.parquet` / `per_event.parquet` (already
  have implied vs actual per event). Likely a thin/rare edge, but cheap to confirm or rule out.

### 4. Earnings calendar spreads (moderate fit)
Sell front-week, buy back-month — harvest the **IV term-structure crush we already compute** in
the scanner.
- **Why it's only moderate:** lower capital than the butterfly and a single structure, but still
  multi-leg slippage; not as clean a small-account fit as #1–2.

---

## Skip for small accounts
- Index/ETF short-vol (capital-heavy).
- The wheel / cash-secured puts on normal-priced names (needs 100 shares of buying power).
- Naked anything (undefined risk + margin).

## Recommended starting point
**PEAD (#1).** Cleanest small-account fit, reuses the exact earnings data already pulled, fastest
to validate (no new fetch), and complements the short-vol scanner: one tab to *sell into*
earnings, one to *ride the drift after*. Validate the drift first (forward returns by surprise ×
liquidity), then decide whether to build a scanner mode for it.
