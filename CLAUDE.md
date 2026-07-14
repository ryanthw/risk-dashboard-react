# CLAUDE.md

Guidance for Claude Code sessions in this repo. Keep it accurate — correct entries here rather than duplicating.

## Data sourcing

Multiple sources are wired up for research and live scanners. Pick by what the task needs (historical vs live, equity vs option, price vs greeks). None is a single do-everything source — match the source to the gap.

| Source | Best for | Historical | Live/near-live | Greeks / IV | Main limitations |
|---|---|---|---|---|---|
| **Robinhood MCP** | Real brokerage fills, historical greeks | ✅ incl. **historical greeks** | ✅ | ✅ historical **and** live | **Very slow polling; many data gaps.** Prices are real (the brokerage I actually trade on). |
| **Public API** | Fast historical OHLCV (equity + options), live greeks | ✅ equity to 1990, single-option daily bars | ✅ quick polling | Live only — **no historical greeks/IV** | Bars are price/volume only; historical greeks must be modeled (BSM). Good live greeks for scanners/deployment. |
| **DoltHub** | Near-live option chains | ~15-min delayed | ✅ | (chain-dependent) | Historical coverage has gaps/limitations; retail-flow bias noted in wheel research. |
| **yfinance** | Big-name equity history + stock metadata | ✅ equities, large caps | delayed | ❌ | Coverage thins for small/illiquid names. Good fundamental/metadata. |
| **Finnhub** | Reliable near-live quotes + metadata | uncertain — verify before relying | ✅ very reliable endpoint | ❌ | Historical depth unconfirmed; treat as a live-quote + metadata source. |

Rules of thumb:
- **Historical greeks/IV** → only Robinhood MCP has them directly. Public gives real historical option *prices*; derive greeks yourself (BSM from option close + underlying close + rate) rather than constructing prices — consistent with the no-constructed-data preference.
- **Fast historical OHLCV** (equity or single option contract) → Public.
- **Live greeks for scanners/strategy deployment** → Public (quick) or Robinhood (real book, slower).
- **Near-live chains** → DoltHub (~15-min delayed).
- **Equity history + stock metadata** → yfinance; **reliable live quotes + metadata** → Finnhub.

### Public API — verified details

- Key: `PUBLI_API_KEY` (note: no `C`) in `~/.zshrc`. **Non-interactive shells/scripts don't source `.zshrc`** — the var is absent in cron/`zsh -c`/tool shells. Read it from the file or move it to `~/.zshenv` for scripts.
- Auth: `POST https://api.public.com/userapiauthservice/personal/access-tokens` with `{"validityInMinutes":N,"secret":<key>}` → `accessToken`; then `Authorization: Bearer <token>` on all calls.
- Accounts: `GET /userapigateway/trading/account`. Brokerage account (Level-2 options, buy/sell) is `5OG07032`.
- Historical bars: `GET /userapigateway/historicdata/{TYPE}/{symbol}/{PERIOD}`, TYPE ∈ `EQUITY|OPTION|CRYPTO|INDEX`. Bars nest under `regularMarket.bars[]` (also `preMarket`); each bar `open/high/low/close/value/volume/timestamp/gain*`. **Prices are strings.**
  - Valid periods (docs are wrong — verified): `DAY WEEK MONTH QUARTER HALF_YEAR YEAR YTD ALL FIVE_YEARS TEN_YEARS`. Docs' `FIVE_YEAR`/`TEN_YEAR` are rejected.
  - Resolution is tied to period: `DAY/WEEK/QUARTER` = intraday, `MONTH`–`FIVE_YEARS` = daily, `TEN_YEARS`/`ALL` = monthly. Can't pick granularity independently.
  - Options use the OSI symbol as `{symbol}`, e.g. `AAPL260821C00310000`.
- Option chain (with **live** greeks): `POST /userapigateway/marketdata/{accountId}/option-chain` with `{"instrument":{"symbol":"AAPL","type":"EQUITY"},"expirationDate":"YYYY-MM-DD"}` → `calls[]`/`puts[]`, each `optionDetails.greeks` = `delta gamma theta vega rho impliedVolatility`, plus `bid/ask/last/volume/openInterest/strikePrice/midPrice`. All numerics are **strings**; there is no expiration-listing endpoint (discover expirations elsewhere, e.g. the CBOE delayed chain).

### DoltHub SQL API — verified details

- `https://www.dolthub.com/api/v1alpha1/post-no-preference/options/master?q=<sql>`; `option_chain` columns include `date act_symbol expiration strike call_put bid ask vol delta` (`vol` = implied vol).
- **`MAX(date)` subqueries time out** ("context deadline exceeded"). Use indexed equality instead: probe `date='YYYY-MM-DD'` walking back from today until rows return (last trading day). Coverage is sparser than CBOE/Public — weeklies and far-dated LEAPS rows may be missing.
