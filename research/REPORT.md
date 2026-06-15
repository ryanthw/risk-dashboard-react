# Earnings Short-Volatility — Findings (expanded universe)

**Question.** Is there a real, tradeable edge selling option premium into earnings (enter the
day before, exit right after the print), with the edge being implied move > actual move? What
predicts success, how to size it, and does it scale across a wide universe?

**Bottom line.** The premium is real and persistent (implied > actual **82%** of the time
across 1,553 names). But it only survives in **defined-risk** form. Across the wide universe,
**naked** straddle/strangle selling *loses money* — small/mid-cap tails overwhelm the premium —
while the **iron butterfly / iron condor** stay robustly profitable and the condor was positive
in **every year and ~every quarter**. The deployed product is a scanner that ranks upcoming
earnings as short iron-butterflies by premium richness × IV × backtested per-name reliability.

---

## 1. Data & method (real data only)

| Component | Source | Coverage |
|---|---|---|
| Universe | full DoltHub option universe (~2,282 clean symbols) → **1,104** with usable history | — |
| Earnings dates + AMC/BMO + EPS | yfinance | 2014–2025 |
| Daily OHLC (actual moves) | yfinance | 2014–2025 |
| Historical EOD option chains (bid/ask/IV/greeks) | **DoltHub** `post-no-preference/options` (free) | ~mid-2020 → 2025 |

**Hard rule: real observed marks only — gaps over constructed data.** For each event we take the
real pre-earnings ATM straddle / Δ16 strangle / Δ5 wings at real mids, then mark the exit from
the **first real post-earnings chain** (T+1, else T+2/T+3), interpolating only *between real
strikes*. Events without real data on both sides are dropped. Result: **13,670 fully-real
trades, 1,553 tickers, 2020-06 → 2025-07, 0 fabricated prices.**

**Limitations (so read these as a conservative lower bound):** the free data has no weekly
expiries (front expiry ≈ 15–21 DTE, not front-week), EOD marks (not the open+15min the strategy
targets), and ~⅓ of exits forced to T+2. A real front-week / open-exit implementation should do
**better**, but execution/slippage is not modeled.

## 2. The edge is real, and it scales

- Median implied move **8.5%** vs median actual move **3.7%**; **P(implied > actual) = 82.3%**
  (essentially unchanged from the S&P-only study — the edge is broad, not a large-cap artifact).
- Realized moves are right-skewed (fat tail) and *fatter* in the broader universe — which is
  exactly why structure choice decides everything.

## 3. P&L by structure — defined-risk is the whole game *(charts `03`, `04`, `07`)*

Per-trade, full sample (return on max-risk for spreads, % of premium for naked):

| Structure | n | Win % | Mean | Profit factor | Edge/σ |
|---|---|---|---|---|---|
| Naked short straddle (%prem) | 13,263 | 59.4 | **−2.7%** | 0.83 | −0.06 |
| Naked short strangle (%prem) | 12,367 | 62.2 | **−7.7%** | 0.77 | −0.07 |
| **Iron butterfly** ATM/Δ5 (%risk) | 10,176 | 63.0 | **+6.2%** | 1.68 | 0.16 |
| **Iron condor** Δ16/Δ5 (%risk) | 4,104 | 70.0 | **+6.3%** | **2.41** | **0.24** |

Across the wide universe the **naked** structures flip *negative* (PF < 1) — the fat left tail
more than eats the premium. The **defined-risk** structures cap that tail and stay strongly
positive; the iron butterfly keeps **~84% of the naked straddle's premium** while bounding loss.
Cleanest exit (**T+1 only**) is better still: iron condor 76.6% win / PF **3.99** / edge-σ 0.38;
iron butterfly Δ5 68.9% win / PF 2.33 / edge-σ 0.24.

**Butterfly vs condor.** Both compound up; the **condor** is the smoother ride (OTM body → less
gamma, PF 2.4, *positive every quarter*, worst-Q ≈ 0%), while the **butterfly** keeps more premium
and has higher upside in calm quarters but a fatter tail (ATM body → worst-Q ≈ −25%). The
3-way distribution *(`04`)* shows it cleanly: the naked straddle's loss tail runs **past −1×**,
while butterfly and condor are bounded at the defined max-loss. Scorecard in `07`.

**Equity curves *(`03`, cumulative quarterly-mean return on capital-at-risk)*:** the iron condor
climbs near-monotonically to ~+205%, the butterfly to ~+135% (with the occasional sharp
give-back), while the naked straddle peaks early and **bleeds to negative** over five years.

## 4. Robustness — positive every year *(chart `06`)*

Mean return on max-risk by year:

| Year | Iron condor | Iron butterfly Δ5 | Naked straddle (%prem) |
|---|---|---|---|
| 2020 | +4.8% | +9.4% | +4.0% |
| 2021 | +9.1% | +6.6% | +0.7% |
| 2022 | +4.5% | +3.6% | **−7.5%** |
| 2023 | +5.1% | +1.5% | **−7.5%** |
| 2024 | +6.0% | +7.9% | −3.5% |
| 2025 | +8.0% | +10.3% | +0.2% |

The condor was positive **every year** (and ~every quarter); the butterfly every year. Naked
selling lost money in 2022–2024. Defined risk is what makes the edge *survivable*.

## 5. What predicts success (ex-ante, known at entry)

- **ATM IV / premium richness** — richest premium = best returns (the core signal).
- **AMC > BMO** — after-close prints isolate the event more cleanly.
- **Sector** — Energy / Staples / Discretionary richest; Materials / Utilities / Real Estate
  thinnest.
- **Per-name reliability** — a name's historical iron-fly win-rate persists (move size autocorr
  ≈ 0.4), which is what the cached reliability table encodes.
- *Caveat:* sorting by `implied − actual` looks spectacular but uses the realized move → it is
  **hindsight, not tradeable**. The scanner uses only forward-known signals.

## 6. Position sizing *(`sizing.py` Monte-Carlo on the real return distribution)*

Iron butterfly Δ5: mean **+5.2%** of defined max-risk/trade, σ 0.31, 63% win.

| Risk / trade | Median CAGR | Worst-1% drawdown |
|---|---|---|
| 1% | ~11%/yr | −7% |
| **2%** | **~23%/yr** | **−13%** |
| 3% | ~37%/yr | −19% |

- Full Kelly is far too hot; size each trade at **1–3% of equity as defined max-loss**, ~¼-Kelly.
- **Diversification is the real control:** a basket of *k* independent earnings trades cuts
  per-trade σ ~5–6× from k=1 → k=20–40. Spread across many names per cluster, cap any single name.

## 7. Deployed scanner

`/scanner` tab + Supabase edge function `earnings-scanner`. Live option chain from **CBOE**
delayed quotes (free, ~15-min, full chain *with greeks*). For each upcoming earnings: AMC/BMO,
live implied move, DTE-robust premium richness (implied vs expected move to that expiry),
suggested **iron-butterfly** strikes/expiry, max gain/loss, and a confidence score blending
richness × per-name win-rate × IV × sample size × AMC × liquidity. **Catch-all:** all upcoming
earnings show — names in the **1,104** backtested cache rank in *Tracked — backtested edge*;
everything else appears below in *No history — live signals only* (richness = live IV
term-structure premium). Free DoltHub caps the backtested cache at ~1,104; going wider needs a
paid options-history source (deferred).

*Charts: `research/out/charts/*.png`. Pipeline (all resumable): `expand_universe` → `pull_extra`
→ `analyze_moves` → `fetch_options` → `backtest` → `butterfly` → `gen_reliability_migration`.*
