# Small-Account Strategy Research — Findings

Companion to `REPORT.md` (the earnings short-iron-butterfly study) and `NEXT_STEPS.md`.
Goal: find a strategy that fits a *small* account better than the diversification-heavy
iron butterfly. Real data only — no constructed prices.

## Landscape update (matters)
**The FINRA Pattern Day Trader rule was eliminated June 4, 2026** — the $25k floor and
4-trades/5-days threshold are gone, replaced by a risk-based intraday-margin framework with a
$2,000 minimum. So "must hold overnight to dodge PDT" is no longer a hard constraint for small
accounts. We still chose an overnight focus (lower variance, and we lack intraday data), but
intraday/0DTE is no longer categorically off the table.

## Candidate menu (10 screened)
PEAD · pre-earnings IV ramp · cheap-vol inverse screen · poor-man's covered call · ETF credit
spreads · earnings calendar/diagonal · sector/cross-sectional momentum · broken-wing butterfly ·
0DTE defined-risk spreads · the wheel on low-priced names. Two were taken to a real-data backtest:
**PEAD (#1)** and **ETF credit spreads (#5)**.

---

## PEAD (#1) — VALIDATED gross, MARGINAL after costs
**Trade:** enter at the *reaction-day close* (skip the event gap), hold N days, market-adjust vs SPY.
67,885 real earnings events, 1,745 tickers, 2014–2025. Script: `scripts/pead.py`,
`scripts/pead_cost.py`. Data: `out/pead_events.parquet`, `out/pead_cost_events.parquet`.

**Gross edge is real and behaves exactly as the literature predicts** (drift concentrates where
limits-to-arbitrage are highest):
- Monotonic in surprise size — only the **big-surprise quartile** drifts (20d +0.46%, t=4.6);
  small surprises are noise.
- Concentrated in **low-liquidity** names: low-liq 20d +0.40% (t=5.1) vs mid/high-liq flat (t<1).
- Best cell (big surprise × low-liq): 20d signed drift **+0.87%, t=5.4**, hit 52.5%.

**After transaction cost it mostly evaporates.** Cost = Corwin-Schultz high-low spread estimator
(real, derived per name from its own daily High/Low; ~0.40% in low-liq names). Net = gross − one
round-trip spread:

| Horizon (big surprise × low-liq) | Gross | NET | net t |
|---|---|---|---|
| 1-day  | +0.24% | **−0.27%** | −5.4 |
| 5-day  | +0.52% | **+0.01%** |  0.1 |
| 20-day | +0.87% | **+0.37%** |  2.3 |

**Verdict:** survives costs *only* as a **20-day hold on the biggest-surprise, lowest-liquidity
names** (+0.37%/trade, t≈2.3, hit ~50.5%). Short-horizon PEAD is dead after the spread. The gross
edge is largely an illiquidity premium paid for crossing the spread — which is why it persists.
Corwin-Schultz charges the *full quoted* spread, so patient limit/fractional execution near mid
pays less; true net sits between gross and the figures above. A tradeable, but thin and
patient, edge — not a slam dunk.

**If productized:** a scanner mode that surfaces *only* top-quartile |surprise| in low-liquidity
names, framed as a ~1-month hold, with an explicit "edge after est. spread" column so the user
sees net not gross. Complements the existing sell-into-earnings scanner (one rides the drift
after, one sells premium into).

## ETF credit spreads (#5) — NO EDGE (naive), open question on management
**Trade:** weekly SPY bull-put + bear-call, ~0.20Δ short, 5-wide, **held to expiration**. Real
DoltHub entry mids + real SPY settlement. 334 trades, 2020–2025. Script: `scripts/credit_spreads.py`,
data `out/credit_spread_trades.parquet`.

| Variant | n | Win % | Mean ret/risk | PF |
|---|---|---|---|---|
| All | 334 | **80.2%** | **−1.16%** | 0.88 |
| Bull put | 167 | 85.6% | +0.67% | 1.01 |
| Bear call | 167 | 74.9% | −2.99% | 0.79 |
| Iron condor | 167 | 63.5% | −3.63% | 0.85 |

The **80% win rate still loses money** — risk/reward is ~3.2:1 against, and full-width losers
overwhelm the frequent small wins. Positive only in 2020 (post-COVID crush); negative every year
since. Mirrors the REPORT's core lesson: short premium doesn't cover its tail.

**Caveats (all conservative):** hold-to-expiration is worst-case management (real traders take 50%
profit / roll at 21 DTE — untested here, needs exit-chain pull); no transaction costs modeled;
DoltHub strikes are coarse. **Open question:** does active management flip it positive? Not yet
tested. As a *naive systematic* strategy it has no edge.

---

## Round 2 — generalizable, deployable-as-a-core-book at $5–7.5k
PEAD was judged too niche/thin to productize. Next question: does a *generalizable* edge deploy at
$5–7.5k? Two tested.

### A. Scale-test the PROVEN iron condor — deployable WITH DISCIPLINE
Script `scripts/scale_test.py` on the real backtested condor trades (`trades_enriched.parquet`).
The edge is already proven (PF 2.4, positive every year). The binding small-account constraint is
**option indivisibility**, not capital: median condor max-loss is **$788/contract** → one contract
is ~13% of a $6,250 account; only ~4% of trades fit a 2% risk budget; achievable concurrency
**k≈2–3** (not the REPORT's k=20–40).

Honest forced-sizing Monte-Carlo (each trade risks its *real* max-loss, 100 earnings-weeks):

| Mode ($6,250) | k | Median | Worst DD | P(<0.5x) |
|---|---|---|---|---|
| Trade ANY name (10–16% bets) | 2 | 3.08x | **−71%** | 0.4% |
| **Only ≤5%-budget names** | 2 | 1.86x | **−10%** | **0%** |
| Only ≤5%-budget names | 3 | 2.52x | −10% | 0% |

**Verdict:** the condor edge DOES scale down — but only if disciplined to **affordable names**
(1-contract max-loss ≤5% of account: cheaper underlyings / narrower wings). That holds drawdowns
~−10% with ~zero ruin; trading "any name" forces a −60-to-86% tail. Concrete product step: add a
**"fits my account" affordability filter** to the existing scanner (hide condors whose max-loss
exceeds X% of the user's account). The one *proven edge* that survives small size.

### B. Dual / TS momentum ETF book — robust, but a RISK play not a return play
Scripts `scripts/pull_etfs.py`, `scripts/momentum.py`. Monthly rebalance, 12m lookback, 5bps cost,
2008–2026, real ETF data (`data/etf_prices.parquet`).

| Strategy | CAGR | Sharpe | Max DD |
|---|---|---|---|
| Buy & Hold SPY | **11.7%** | 0.71 | −46% |
| Dual momentum GEM | 8.2% | 0.59 | −20% |
| TS-momentum sleeve | 5.7% | **0.74** | **−9%** |

**Verdict:** no variant beat buy-and-hold SPY on RETURN (a once-in-a-generation bull market). The
edge momentum delivered is **crash protection / drawdown control**: TS-momentum dodged 2008
(−2.5% vs SPY −38%), −9% lifetime max DD, Sharpe 0.74 > SPY's 0.71. A generalizable, low-maintenance
core book — choose it for the smooth ride, not to beat the index.

## Recommendation (updated)
The two **complement** into a coherent $5–7.5k book:
- **Core (low-touch, crash-proof):** dual-momentum GEM / TS-momentum sleeve on the bulk of capital.
- **Satellite (return booster):** disciplined affordable-name iron condors on spare BP — the proven
  edge, shown to survive small size *iff* filtered for affordability.

Highest-leverage build: the scanner **affordability filter** (turns the existing, proven tool into
something a $5–7.5k account can actually trade). Momentum book is a separate, simple monthly-rotation
tab. PEAD/credit-spreads shelved.
