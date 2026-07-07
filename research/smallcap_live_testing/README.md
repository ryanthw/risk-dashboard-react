# smallcap_live_testing

Automated mark-to-market **forward test** for the small-cap wheel. `wheel_sim.py`
pulls live data (Public API), fills at the option **mark** subject to a liquidity
gate, runs the whole wheel lifecycle against an internally-managed portfolio, and
— via GitHub Actions — commits its state and emails each run. No broker, no manual
clicking. `track_performance.py` charts the result vs SPY.

**Honest tradeoff:** mark fills skip real execution/slippage, so treat the results
as an *optimistic upper bound*; the liquidity gate (`volume ≥ 10 OR
open-interest ≥ 50`) and not crossing the spread partly offset it.

## The policy it runs (the researched config)
`Config` in `wheel_live.py` = the Monte-Carlo's best risk-adjusted cell
(**filtered · prem≥0.8 · hold-and-CC** → MC median +16.7% CAGR, ~8% max-DD,
beat SPY in 84% of stress paths):

- **Universe / eligibility**: optionable, currently **< $10** (point-in-time).
- **Filter** (skip likely go-to-zero names):
  - `dd252 ≤ 0.60` — not >60% below its 1-yr high (falling knife)
  - `dilution_1y ≤ 2.0` — split-adj shares not >2× in a year (death spiral)
  - not `BIOTECH_BINARY` — no FDA/trial binary-catalyst names
  - `TTM revenue ≥ $10M` — no pre-revenue story stocks (NOT a profit screen —
    the universe is unprofitable by design; this is a *revenue-existence* floor)
  - no **earnings** inside the cycle
- **Entry**: nearest listed strike to `0.90 × spot`, monthly 25–50 DTE, only if
  annualized yield `credit/strike × 365/dte ≥ 0.80`.
- **Exit**: pure **hold-and-CC** — take assignment, write covered calls at ≥
  basis until called away. `--bail 0.70` switches to the tail-safe bail30 variant.
- **Sizing**: one position per name, 10% of equity each, cash-secured.

Change thresholds in the `Config` dataclass, not inline, so live rules stay
traceable to the backtest.

## How it runs — GitHub Actions (automated)
`.github/workflows/wheel-forward-sim.yml` runs `wheel_sim.py` on a schedule
(`30 21 * * 1-5` = **21:30 UTC weekdays**, ~30–90 min after the US close; GitHub
cron is best-effort and often delayed), commits `state/portfolio.json` +
`equity_log.csv` + `trades.csv` back to the repo (git history = audit trail),
and emails each run.

One-time setup:
1. Commit the package + its data: `research/smallcap_live_testing/`,
   `research/smallcap/universe_expanded.csv`, `research/data/shares_adj.parquet`.
2. Repo **Secrets** (Settings → Secrets and variables → Actions): `PUBLI_API_KEY`,
   `WHEEL_SMTP_USER`, `WHEEL_SMTP_PASS`, `WHEEL_EMAIL_TO`.
3. Actions **read+write** permission (Settings → Actions → General → Workflow
   permissions) so it can commit state back.
4. First run initializes state at $100k (edit `START_EQUITY` in `wheel_sim.py`
   for a different base). Trigger via **Run workflow** or wait for the schedule.

**Behavior:** it ramps up over the first several days (deploys ~10%/position, one
per name, until cash is ~fully invested), then goes quiet until an expiration or
assignment triggers a covered-call write / bail + redeploy — roughly monthly
activity, not daily rolling.

**Caveats:** GitHub cron auto-disables on repos inactive >60 days; Yahoo
(yfinance, for the earnings + revenue gates) sometimes rate-limits cloud IPs —
when it does those two gates soft-pass (dd / dilution / biotech / price / yield /
volume still apply via committed data).

## Run locally
```bash
python3 research/smallcap_live_testing/wheel_sim.py --email you@x   # --bail 0.70 optional
```
Needs `PUBLI_API_KEY` in the env (or `~/.zshrc`) and the `WHEEL_SMTP_*` vars for
`--email`. State persists in `state/portfolio.json`; it appends to
`equity_log.csv` / `trades.csv`.

## Performance tracking
`track_performance.py` reads the sim's `equity_log.csv` (`date,account_value,
cash`) and `trades.csv`, builds the equity curve → total return / CAGR /
max-drawdown, and compares it to **SPY buy-and-hold over the same window**
(auto-fetched), plus assignment/win rate.
```bash
python3 research/smallcap_live_testing/track_performance.py
```
**Early numbers are noisy** (annualizing a few weeks gives wild CAGRs) — judge
over months. To cross-check against reality, append your real broker account
value to `equity_log.csv` and real fills to `trades.csv` and it measures the
mark-vs-real slippage gap.

## Notes
- **Mark fills are optimistic** — the real-execution slippage on thin small-cap
  options is exactly what mark-filling hides; treat the sim CAGR as an upper bound.
- **SNDL-type names** can pass every mechanical filter yet price a huge premium
  because the market sees real distress (SNDL ~243% yield) — worth an eyeball.
- `wheel_live.py` also has a manual order-elicitation mode (`python3 wheel_live.py
  --equity … --cash … [--positions …] --email …`) that emails a plan to place in a
  real broker, if you ever want a broker-fill cross-check. It shares the same
  `Config`, and `wheel_sim.py` imports from it — so keep it.
