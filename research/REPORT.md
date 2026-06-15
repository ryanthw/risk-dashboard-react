# Earnings Short-Volatility Research — Findings & Scanner Design

**Question:** Is there a real, tradeable edge in selling option premium into earnings
(enter the day before, exit right after the print), where the edge is the implied
move overstating the actual move? If so, what predicts success, how should it be
sized, and how do we scan for it?

**Bottom line:** Yes, the premium is real and persistent. But the *naked* short
straddle/strangle is fragile — its fat left tail nearly eats the whole edge and it
suffered a brutal 2-year drawdown in 2022–23. The **defined-risk iron condor is the
standout**: it captures the same premium while capping the tail, and it was profitable
**every year 2020–2025**, producing a near-monotonic equity curve. The actionable
product is a scanner that ranks upcoming earnings by premium richness × liquidity ×
historical reliability, traded as small, broadly-diversified iron condors.

---

## 1. Data & method (real data only)

| Component | Source | Coverage |
|---|---|---|
| Universe | S&P 500 constituents | 503 names |
| Earnings dates + timestamps (AMC/BMO) + EPS surprise | yfinance | 2014–2025, 21,636 events |
| Daily OHLC (actual moves) | yfinance | 2014–2025, 1.5M rows |
| **Historical EOD option chains** (bid/ask/IV/greeks) | **DoltHub `post-no-preference/options`** (free SQL API) | ~mid-2020 → 2025 |

**Methodology, and a hard rule we followed:** *use only real observed option marks —
prefer gaps over constructed data.* For every event with a real pre-earnings chain we
took the real ATM straddle / Δ16 strangle / Δ5 wings at their real mid prices, then
marked the exit using the **first real post-earnings chain** (T+1, else T+2/T+3),
interpolating prices **between real adjacent strikes only** (no Black-Scholes fill, no
modeled IV). Events lacking real data on both ends were dropped.

- Real-data hit rate ≈ **45%** → **4,403 fully-real reconstructed trades**, 467 tickers,
  2020-06 → 2025-07, **0 fabricated prices**.
- Coverage is richest in recent years (2025 ≈ 95%), which is exactly the regime that
  matters most.

**Known limitations (read before trusting any single number):**
1. **No weekly expirations in the free dataset.** Nearest expiration is ~15–21 DTE, not
   the front-week a real earnings trader sells. So our straddle holds residual time
   value at exit → we capture only the IV-crush portion, **understating** the premium a
   true front-week trade would harvest. The *edge direction* is robust; absolute capture
   is conservative.
2. **Exit day:** 34% of exits were forced to T+2 because no real T+1 chain existed. T+2
   adds a day of drift/decay and drags the blended numbers. The **T+1-only subset is the
   cleanest proxy** for the actual strategy and is materially better (see §4).
3. EOD marks, not the open+15min the strategy actually targets.
4. Survivorship: current S&P 500 membership.

Net: treat results as a **conservative lower bound** on the edge.

---

## 2. The edge is real: implied > actual

Across 4,403 real events *(chart `01`, `02`)*:

- Median implied move (straddle/spot, ~15–21 DTE) **6.70%** vs median actual 1-day move **3.07%**.
- **Implied move exceeded the actual move 82.3% of the time.**
- Realized S&P 500 earnings moves (full 10yr, n=21,636, *chart `07`*): median **2.84%**,
  mean 3.92%, but a **fat right tail** — p95 = 11.3%, p99 = 18.4%, max 52%. An earnings
  day is ≈ **1.8× a normal daily move**.
- Move size **persists**: corr 0.41 between a name's prior-average move and its next move
  — this is what makes a per-name benchmark predictive.

The risk premium exists for the reason the video gives: into earnings, demand to *buy*
protection/speculation rises while supply of *sellers* falls → options get rich.

---

## 3. P&L by structure — the central result

Per-trade, full real sample (exit blended T+1–T+3):

| Structure | n | Win % | Mean | Median | Avg win | Avg loss | Profit factor | Edge/σ |
|---|---|---|---|---|---|---|---|---|
| Short straddle (% premium) | 4,369 | 63.7 | +0.3% | +10.3% | +21.9% | −37.9% | 1.02 | 0.008 |
| Short strangle Δ16 (% prem) | 4,182 | 67.9 | +0.9% | +27.8% | +43.1% | −90.8% | 1.03 | 0.009 |
| **Iron condor Δ16/Δ5 (% risk)** | **2,568** | **69.6** | **+3.9%** | **+4.7%** | +11.4% | −13.5% | **1.96** | **0.20** |

**Read this carefully:** the naked straddle/strangle have a *positive median* and a 64–68%
win rate, but their **mean edge is ~zero** because the left tail (avg loss −38% to −91% of
premium) almost exactly offsets the many small wins. Profit factor ≈ 1.0. They are
**barely-profitable, high-variance** bets on the full sample.

The **iron condor** keeps a ~70% win rate but its **wings cap the catastrophic losses**, so
the edge survives: profit factor 1.96, risk-adjusted edge **25× better** than the naked
versions. On a per-notional basis the ordering is the same (IC edge/σ 0.21 > strangle 0.09
> straddle 0.05).

### Cleanest exit (T+1 only — the real strategy's timing)
| Structure | n | Win % | Mean | Profit factor | Edge/σ |
|---|---|---|---|---|---|
| Straddle (% prem) | 1,486 | 66.4 | +3.4% | 1.27 | 0.089 |
| Strangle (% prem) | 1,341 | 72.9 | +10.4% | 1.47 | 0.110 |
| **Iron condor (% risk)** | 658 | **75.7** | **+5.6%** | **3.64** | **0.44** |

With a clean next-day exit, **all three are clearly profitable** and the iron condor is
exceptional (76% win, PF 3.6). The full-sample drag was the forced T+2 exits.

### Equity curves *(chart `03`)* — the picture that tells the story
- **Naked straddle:** +40 units by 2022 → gave it ALL back through 2022–23 → bottomed −40 →
  recovered in 2025. Net ~flat over 5 years with a savage 2-year drawdown.
- **Iron condor:** a near-straight climb **0 → +100 units of risk**, barely a wobble through
  the same 2022–23 regime. This is the "smooth, uncorrelated equity curve" the strategy is
  famous for — reproduced here, **but only for the defined-risk structure.**

---

## 4. Robustness *(charts `06`, and by-year table)*

Mean per-trade return by year:

| Year | n | Straddle (%prem) | Straddle win% | **Iron condor (%risk)** |
|---|---|---|---|---|
| 2020 | 397 | +4.8% | 69 | **+4.3%** |
| 2021 | 755 | +2.5% | 66 | **+5.4%** |
| 2022 | 751 | **−4.0%** | 58 | **+1.7%** |
| 2023 | 723 | **−5.5%** | 58 | **+2.4%** |
| 2024 | 916 | −0.4% | 60 | **+4.4%** |
| 2025 | 861 | +5.7% | 70 | **+6.0%** |

The naked straddle **lost money in 2022 and 2023** (high-vol, trending, big-surprise
regime). The **iron condor was positive in every year**, including that regime. This is the
single most important robustness fact: defined risk is what makes the edge *survivable*.

**Exit-lag sensitivity:** T+1 exits +3.4% vs T+2 −1.4% (straddle %prem) — earlier exit is
better, consistent with the strategy's "get out the next morning" rule.

---

## 5. What predicts success (factors)

Tradeable, **known-at-entry** signals (correlations with straddle %-prem return):

| Signal | Effect | Notes |
|---|---|---|
| **ATM IV level** | corr **+0.105**; low-IV quintile −4.4% → high-IV quintile **+6.7%** | Higher-IV names carry more risk premium. Strongest clean signal. |
| **Timing AMC vs BMO** | AMC +1.1% vs BMO −0.1% | After-close prints isolate the event cleanly; prefer AMC. |
| **IMEM vs own avg move** | corr +0.067; rich quintile +7.2% vs cheap −7.1% | The video's signal — directionally right but **weak** here (see caveat). |
| **Sector** | Energy/Staples/Discretionary best (+2.4–3.4%); Materials/Utilities/Industrials worst (−2 to −0.8%) | High-IV growth/consumer names > low-vol cyclicals/defensives. |
| Liquidity | (not in this dataset) | Essential in practice — fills dominate P&L. Use option volume/OI live. |

**Important caveat on the headline "implied − actual" signal.** Sorting by
`implied − actual` shows a huge monotonic effect (Q1 −50% → Q5 +21%, corr 0.53) — but that
uses the *realized* move, so it's **hindsight, not tradeable**. The honest ex-ante version
(`implied vs the name's historical average move`) is real but weak in this dataset, mostly
because the free data's ~15–21 DTE implied move isn't on the same scale as a 1-day move. A
live scanner using **front-week** straddles will get a far cleaner version of this signal.

**Practical filter set that the data supports:** liquid + high-IV + AMC + premium rich vs
the name's own history, structured as a defined-risk condor, spread across many names.

---

## 6. Position sizing *(from `sizing.py` Monte-Carlo on the real return distribution)*

Per-trade iron condor: mean **+3.7% of max-risk**, σ 0.18, win 69.6%, worst-case ≈ −0.94×
the defined risk (i.e., a loss is bounded — that's the point).

- **Full Kelly is a trap.** Continuous-Kelly on defined risk computes f* ≈ 1.2 (risk >100%
  of equity/trade) because max-loss is a small denominator; this ignores estimation error
  and the fat tail. **Use a small fixed fraction.**
- Monte-Carlo (≈400 trades ≈ 2 active years), risking a fixed % of equity as **defined
  max-loss per trade**:

| Risk/trade | Median CAGR | Median maxDD | Worst-1% maxDD | P(lose >50%) |
|---|---|---|---|---|
| 1% | ~8%/yr | −2% | −3% | 0% |
| **2%** | **~16%/yr** | **−3%** | **−7%** | **0%** |
| 3% | ~24%/yr | −5% | −10% | 0% |
| 5% | ~44%/yr | −8% | −16% | 0% |

- **Diversification is the real risk control** *(the video's core point, confirmed)*. A basket
  of *k* independent earnings condors collapses volatility: σ 0.18 (k=1) → 0.08 (k=5) →
  0.056 (k=10) → 0.028 (k=40); P(basket loses money) 30% → 9%. Earnings events are roughly
  uncorrelated, so many small bets convert a coin-flip single trade into a steady aggregate.

**Recommendation:**
- Trade **defined-risk iron condors**; size each at **1–3% of equity as max-loss** (start at
  the low end; this is ~¼-Kelly given model uncertainty).
- Run **15–40 names per earnings cluster**; cap any single name and cap aggregate at-risk
  (e.g. ≤ 25–30% of equity across all open condors).
- For naked straddles/strangles (undefined risk), size **much smaller** (≤0.5–1% notional)
  and only on the most liquid names — the unbounded left tail is not worth it given the
  condor captures ~the same edge with a cap.
- Always buy the cheap far wings ("pennies") even when selling strangles, purely to cap
  disaster — not for risk/reward.

---

## 7. Scanner design for the dashboard (the deliverable)

A daily "Earnings Premium Scanner" panel. **Edge is in the event**; the scanner's job is to
(a) find tomorrow's tradeable earnings and (b) rank by quality so you trade the best subset.

**Inputs / data sources**
- Earnings calendar (today AMC + tomorrow BMO): Finnhub `/calendar/earnings` (you have a key)
  or yfinance as backup.
- **Live** option chain for the front expiration *after* the print: brokerage API. The
  Robinhood MCP already exposes `get_option_chains` / `get_option_quotes` / greeks — usable
  for ATM straddle, Δ-strikes, bid/ask, IV, volume/OI. (Free historical IV came from DoltHub
  for research; live scanning should use the brokerage chain to get real front-week strikes.)
- Historical realized moves per name: precompute from yfinance (already built —
  `per_event.parquet`).

**Per-candidate signals to compute & display**
1. **Implied earnings move** = ATM straddle (front post-earnings expiry) / spot.
2. **Avg historical move** = mean |close-to-close| over last 8–12 earnings (we have this).
3. **Premium richness** = implied move ÷ avg historical move (the headline rank). >1 = rich.
4. **Historical straddle-sell return** over last N earnings (the video's "is it positive").
5. **ATM IV / IV-rank** (higher = more premium; top clean factor in our data).
6. **Liquidity** = front-expiry option volume + OI + bid/ask width (hard gate; e.g. ≥1,000
   ADV, spread ≤ X%).
7. **Timing** = AMC vs BMO; **sector**; **EPS-surprise consistency**.

**Composite score** (rank, then trade the top liquid subset):
```
score = z(premium_richness) + z(IV_rank) + z(hist_straddle_winrate)
        + 0.5*z(avg_move_persistence) + AMC_bonus + sector_tilt
gated by: liquidity_ok AND earnings_confirmed_date
```
**Suggested trade template per candidate:** short Δ16 strangle + long Δ5 wings (iron condor),
front expiry after the print; show credit, defined max-loss, breakevens, and the
**position size = round(account × risk% / max_loss)**.

**Dashboard UI:** a sortable table (ticker, date, AMC/BMO, implied move, avg move, richness,
IV-rank, hist win-rate, liquidity, suggested condor + size), plus a per-name drill-down with
the historical move distribution and a backtest sparkline. Reuse the existing industrial
blue/steel chart palette.

**Risk integration:** feed each proposed condor's defined max-loss and aggregate at-risk into
the existing risk dashboard so concurrent-earnings exposure is visible alongside the rest of
the book.

---

## 7b. Iron BUTTERFLY (the "defined-risk straddle") — what we built the scanner around

Re-running the same real trades as a short **iron butterfly** (short ATM straddle body +
long OTM wings), since the body is the straddle itself:

| Structure (return on max-risk, full sample) | n | Win % | Mean | PF | Edge/σ |
|---|---|---|---|---|---|
| Iron condor (Δ16 body / Δ5 wings) | 2,568 | 69.6 | +3.9% | 1.96 | 0.20 |
| **Iron butterfly (ATM / Δ5 wings, wide)** | 3,671 | 65.4 | +3.7% | 1.55 | 0.15 |
| Iron butterfly (ATM / Δ16 wings, tight) | 4,008 | 60.6 | +3.2% | 1.30 | 0.09 |

- The butterfly **keeps ~91% of the naked straddle's premium** while capping the tail — the
  "straddle proxy with defined risk."
- **Wing width matters:** wide (≈Δ5–Δ10, near the expected-move edge) clearly beats tight (Δ16).
- Mean return on capital ≈ the condor's, with **more variance** and slightly less robustness in
  the worst regime (2023 ≈ flat vs condor +2.4%), but **higher upside in good years**
  (2025 +8.5% vs +6.0%). T+1-only: 72.6% win, +8.0%/risk, PF 2.71.
- Design constants used by the scanner: Δ-wing butterfly collects credit ≈ **37% of wing width**
  → **max gain = credit, max loss ≈ 63% of width**.

**Scanner shipped:** a new **Earnings Scanner** tab (`/scanner`) — refresh button, confidence-
ranked chart, and a per-ticker table (earnings date + AMC/BMO, **live** implied move from Yahoo
options, historical avg move + backtested fly win-rate from the seeded reliability table,
suggested iron-butterfly strikes + expiry, max gain/loss, and a confidence score blending
premium-richness × historical win-rate × IV × sample-size × AMC × liquidity). Backend is a
Supabase edge function (`earnings-scanner`); per-ticker reliability seeded from this research
(`supabase/migrations/0002_earnings_scanner.sql`, 372 names). The live scanner uses **front-week**
options — the apples-to-apples implied-vs-avg-move signal the free historical data couldn't give.

## 8. Honest caveats

- This is a **conservative, real-data lower bound**: ~15–21 DTE options (no weeklies), EOD
  marks, ~⅓ of exits forced to T+2. A real front-week, T+1-morning implementation should do
  **better** than these numbers, not worse — but execution/slippage is the hard part and is
  *not* modeled here.
- Naked short vol is genuinely dangerous; the 2022–23 straddle drawdown is real and would
  have shaken most traders out. The iron condor is the risk-managed way to harvest the same
  premium.
- Next data upgrade for a production backtest: a source with **historical weekly-expiry**
  option prices (ORATS, CBOE DataShop, or polygon.io options) to model the true front-week
  trade and exit at the open. Validate the live scanner's signal against that before scaling
  size.

---

## 9. Production status — shipped & expanded (live)

The scanner is built and deployed (Supabase edge function `earnings-scanner` + the
`/scanner` tab). Two changes since the original research:

**Live options source = CBOE (not Yahoo).** Yahoo's `/v7/finance/options` endpoint now
returns `401 Invalid Crumb`, so the live chain comes from **CBOE delayed quotes**
(`cdn.cboe.com/.../delayed_quotes/options/{SYM}.json`, free, ~15-min delayed, full chain
**with greeks** — wing deltas are read directly, no Black-Scholes needed). The structure
shown is the **iron butterfly** (short ATM straddle + ~Δ10 long wings). Premium richness is
DTE-robust: live implied move vs the expected move *to that same expiry* (earnings jump +
diffusion), so 2-DTE front-week and 31-DTE monthly names are comparable.

**Universe expanded 372 → 1,104 backtested names.** The reliability backtest was re-run over
the **entire DoltHub option universe** (~2,290 symbols → 2,282 clean equities), same rules as
above (real-data only, T+1..T+3 exits, ≥3 valid events per name). Yield:

| | |
|---|---|
| DoltHub symbol ceiling | ~2,290 (hard cap of the free source) |
| Live + non-delisted | ~96% of sampled names |
| Cleared ≥3 real both-sided events → cache | **1,104 names** (~3× the original 372) |
| Total real reconstructed trades | 13,687 across 1,557 tickers |
| Dropped | delisted, or genuine no/partial DoltHub coverage (nothing constructed) |
| Supabase storage | 1,104 summary rows ≈ <1 MB (free-tier 500 MB — trivial) |

Reaching ~1,104 is essentially the full free-DoltHub yield; ~5,000 *backtested* names would
require a paid options-history source (ORATS / Polygon / CBOE DataShop) and is deliberately
left for later.

**Catch-all behaviour.** The scanner no longer hides non-cached names. The whole Finnhub
calendar flows through (tracked names prioritised, then analyst-covered, capped per scan).
Names with backtested history rank in a **"Tracked — backtested edge"** group; everything
else appears below in **"No history — live signals only"** (richness = live IV
term-structure premium), tagged `no hist`. So every upcoming earnings with listed options is
visible; the 1,104-name cache adds the historical-edge signal to as many as the free data
allows.

*Pipeline to regenerate/expand: `expand_universe.py` (enumerate DoltHub) → `pull_extra.py`
(yfinance) → `analyze_moves.py` → `fetch_options.py` (real option legs) → `backtest.py` →
`butterfly.py` (reliability) → `gen_reliability_migration.py` (Supabase seed). All resumable.*

*Artifacts: `research/out/charts/*.png`, `research/out/trades_enriched.parquet`,
`research/out/per_event.parquet`, scripts in `research/scripts/`.*
