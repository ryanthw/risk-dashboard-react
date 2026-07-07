# smallcap_live_testing

Paper-trading order engine for the small-cap wheel. Given live market data
(Public API) + your current positions, it **elicits** a reviewable order plan —
it never auto-executes. You review, then place the orders in your paper account.

## The policy it runs (the researched config)
Default `CONFIG` in `wheel_live.py` = the Monte-Carlo's best risk-adjusted cell
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
  basis until called away. `--bail 0.70` switches to the tail-safe bail30
  variant (lower worst-case, slightly lower CAGR).
- **Sizing**: one position per name, 10% of equity each, cash-secured.

Change thresholds in the `Config` dataclass, not inline, so live rules stay
traceable to the backtest.

## Run it manually
```bash
# from repo root (runs from any cwd — paths are __file__-relative)
python3 research/smallcap_live_testing/wheel_live.py \
    --equity 100000 --cash 100000 \
    --positions research/smallcap_live_testing/positions.csv
# --bail 0.70   use the bail30 exit variant
# --email you@x  email the plan
# --only-if-actionable   print/email only when there are orders to place
```
Every run with orders writes a dated audit CSV to `orders/orders_YYYY-MM-DD.csv`.

### positions.csv
Maintain this from your broker (see `positions_example.csv`). One row per leg:
| type | meaning | fill these columns |
|------|---------|--------------------|
| `put` | open short put | strike, expiry, qty |
| `shares` | assigned stock | qty, basis, assign_close (for bail), has_open_call (yes/no) |
| `call` | covered call written | strike, expiry, qty |

## When to run it
The engine self-targets the monthly expiration ~25–50 DTE, so it only proposes
**new entries** while that window is open (~once/month), and **management**
orders (covered calls after assignment, bail, expiry heads-ups) whenever a
position needs them. Recommended: **run every weekday morning (~10:00 ET)** with
`--only-if-actionable --email` — you get pinged *only* on days there's something
to do (the entry window opening, a CC to write, a bail, an expiry). After you
place orders, update `positions.csv` so those names drop off the next run.

## Automated email (cron)
1. `cp .env.example .env` and fill it in. For `WHEEL_SMTP_PASS` create a **Gmail
   App Password** (Google Account → Security → 2-Step Verification → App
   passwords) — not your login password. `.env` is gitignored.
2. `chmod +x run.sh` and test: `./run.sh` (writes to `orders/run.log`).
3. Schedule it. macOS `crontab -e`:
   ```
   0 10 * * 1-5  /full/path/to/research/smallcap_live_testing/run.sh
   ```
   (10:00 local, weekdays). **Caveat:** cron won't fire while the Mac is asleep
   — for reliability use `launchd` with `RunAtLoad`, keep the machine awake, or
   move `run.sh` to an always-on box / small cloud VM / GitHub Actions
   (scheduled workflow with the keys as encrypted secrets).

## Performance tracking
`track_performance.py` turns two files you maintain into a dashboard:

- **`equity_log.csv`** (`date,account_value,cash`) — the headline. Once a week,
  read your **thinkorswim paperMoney account value** and append a row. The
  tracker builds the equity curve → total return, CAGR, max-drawdown, and
  compares it to **SPY buy-and-hold over the same dates** (auto-fetched).
- **`trades.csv`** (`date,ticker,action,qty,plan_price,fill_price,status`) — for
  attribution. Log each fill with the plan's mid price and what you actually
  got. The tracker reports **fill slippage vs plan** (the #1 live risk),
  assignment rate, and win rate vs the backtest (`status`: open / expired /
  assigned / called_away / closed / bail).

Run it any time:
```bash
python3 research/smallcap_live_testing/track_performance.py
```
It degrades gracefully — with only `equity_log.csv` you still get the account
vs-SPY headline. **Early numbers are noisy** (annualizing a few weeks gives wild
CAGRs); judge the strategy over months, watching whether live slippage and
assignment rate track the backtest, not the first few prints. thinkorswim's own
Account Statement (exportable CSV) is the source of truth for fills/value —
these tools add strategy attribution + the SPY benchmark on top.

## Two ways to run the forward test
**A. Manual paper trading** (`wheel_live.py` → place in a broker → log fills):
real fills, measures true slippage, but manual. See sections above.

**B. Automated mark-to-market simulation** (`wheel_sim.py`): fully hands-off, no
broker. It fills at the option **mark** (mid) subject to a liquidity gate
(`volume ≥ 10 OR open-interest ≥ 50`), runs the whole wheel lifecycle against an
internally-managed portfolio, and writes the same `equity_log.csv` / `trades.csv`
the tracker reads. **Honest tradeoff:** mark fills skip real execution/slippage,
so treat its results as an *optimistic upper bound*; the liquidity gate + not
crossing the spread partly offset it. State persists in `state/portfolio.json`.

Run it locally:
```bash
python3 research/smallcap_live_testing/wheel_sim.py --email you@x   # --bail 0.70 optional
```

### Fully automated via GitHub Actions
`.github/workflows/wheel-forward-sim.yml` runs the simulator on a schedule,
commits the updated state back to the repo (full audit trail in git history),
and emails each run. Setup:
1. **Commit** the package + its data: `research/smallcap_live_testing/`,
   `research/smallcap/universe_expanded.csv`, `research/data/shares_adj.parquet`.
2. Add repo **Secrets** (Settings → Secrets and variables → Actions):
   `PUBLI_API_KEY`, `WHEEL_SMTP_USER`, `WHEEL_SMTP_PASS`, `WHEEL_EMAIL_TO`.
3. Trigger once via **Run workflow** — the first run initializes state at $100k
   (edit `START_EQUITY` in `wheel_sim.py` first for a different base).

Caveats: GitHub cron can be delayed and is auto-disabled on repos inactive >60
days; Yahoo (yfinance, used for the earnings + revenue gates) sometimes
rate-limits cloud IPs — when it does, those two gates soft-pass (the dd /
dilution / biotech / price / yield / volume gates still apply via committed
data). Run `track_performance.py` any time for the equity-curve + SPY dashboard.

## Notes / manual overrides
- **SNDL-type names**: a name can pass every mechanical filter yet price a huge
  premium because the market sees real distress (e.g. SNDL ~243% yield). These
  are the ones to eyeball and possibly veto by hand.
- `** earnings UNVERIFIED **` flags a name whose next earnings date could not be
  confirmed — check it manually before selling.
- Fills on thin small-cap options are the #1 backtest→live risk. Place LIMIT
  orders at/near the quoted mid and log what actually fills vs the plan.
