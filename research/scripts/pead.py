"""PEAD validation — does post-earnings announcement drift exist in our data?

Thesis (NEXT_STEPS #1): stocks that beat/miss tend to drift in the surprise
direction for days-weeks AFTER the print, and the effect persists in smaller,
less-covered names that institutions arbitrage less.

Method (real data only, no constructed prices):
  * Reaction day = first session whose price reflects the news (AMC -> D+1, BMO/UNK -> D).
  * We deliberately SKIP the reaction-day gap (that's the event move, already priced)
    and enter at the reaction-day CLOSE, then measure forward 1/5/20-day drift.
  * Market-adjust every forward return by subtracting SPY's same-window return,
    so we isolate idiosyncratic drift, not beta.
  * Liquidity proxy = trailing-60d median dollar volume (Close*Volume) at entry.
  * Bucket by surprise sign & magnitude x liquidity x horizon.
Drops any event lacking real prices on both ends. Prints whether the drift is real
and tradeable before we build anything.
"""
import os, warnings
import numpy as np
import pandas as pd
warnings.filterwarnings("ignore")

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
OUT  = os.path.join(os.path.dirname(__file__), "..", "out")
os.makedirs(OUT, exist_ok=True)

HORIZONS = [1, 5, 20]               # forward trading days of drift to measure
LIQ_WINDOW = 60                     # trailing sessions for the liquidity proxy

# --- earnings table ------------------------------------------------------
earn = pd.read_parquet(os.path.join(DATA, "earnings_dates.parquet"))
earn = earn.rename(columns={"Earnings Date": "ts"})
earn["ts"] = pd.to_datetime(earn["ts"], utc=True).dt.tz_convert("America/New_York")
earn = earn[earn["Event Type"].fillna("Earnings").str.contains("Earnings", case=False, na=True)]
earn["cal_date"] = earn["ts"].dt.normalize().dt.tz_localize(None)
hour = earn["ts"].dt.hour + earn["ts"].dt.minute / 60.0
def timing(h):
    if h >= 16: return "AMC"
    if h <= 9.5: return "BMO"
    if 11.5 <= h <= 12.5: return "UNK"   # yfinance default-noon = unspecified
    return "DMT"
earn["timing"] = hour.map(timing)
earn["surprise"] = pd.to_numeric(earn["Surprise(%)"], errors="coerce")
earn = earn.dropna(subset=["surprise"])

# --- prices --------------------------------------------------------------
px = pd.read_parquet(os.path.join(DATA, "prices.parquet"))
px["Date"] = pd.to_datetime(px["Date"], utc=True).dt.tz_localize(None).dt.normalize()
px = px.sort_values(["ticker", "Date"]).drop_duplicates(["ticker", "Date"])

# SPY benchmark forward returns, indexed by trading-day position
spy = px[px.ticker == "SPY"].reset_index(drop=True)
spy_dates = spy["Date"].values
spy_close = spy["Close"].values
spy_pos = {d: i for i, d in enumerate(spy_dates)}

rows = []
for tk, g in px.groupby("ticker"):
    if tk == "SPY":
        continue
    g = g.reset_index(drop=True)
    dates = g["Date"].values
    c = g["Close"].values
    v = g["Volume"].values
    dollar_vol = c * v
    ev = earn[earn.ticker == tk]
    for _, e in ev.iterrows():
        d = np.datetime64(e["cal_date"], "ns")
        idxs = int(np.searchsorted(dates, d))
        if idxs >= len(dates):
            continue
        day_i = idxs  # first trading day on/after cal_date
        t = e["timing"]
        # reaction day: the session whose close already reflects the news
        react_i = day_i + 1 if t == "AMC" else day_i
        if react_i < LIQ_WINDOW or react_i >= len(dates):
            continue
        entry_close = c[react_i]
        if entry_close <= 0:
            continue
        entry_date = dates[react_i]
        if entry_date not in spy_pos:
            continue
        si = spy_pos[entry_date]
        liq = np.median(dollar_vol[react_i - LIQ_WINDOW:react_i])
        rec = dict(
            ticker=tk, earnings_date=pd.Timestamp(dates[day_i]), timing=t,
            entry_date=pd.Timestamp(entry_date), surprise=e["surprise"],
            dollar_vol=liq,
        )
        ok = True
        for h in HORIZONS:
            if react_i + h >= len(dates) or si + h >= len(spy_close):
                ok = False
                break
            stock_ret = c[react_i + h] / entry_close - 1.0
            mkt_ret = spy_close[si + h] / spy_close[si] - 1.0
            rec[f"fwd{h}"] = stock_ret
            rec[f"adj{h}"] = stock_ret - mkt_ret   # market-adjusted drift
        if ok:
            rows.append(rec)

ev = pd.DataFrame(rows)
ev.to_parquet(os.path.join(OUT, "pead_events.parquet"), index=False)

# --- directional signed drift: does it drift WITH the surprise? -----------
ev["sign"] = np.sign(ev["surprise"])
ev = ev[ev["sign"] != 0]
# signed drift = market-adjusted forward return * sign(surprise);
# positive => price drifts in the surprise direction (PEAD confirmed)
for h in HORIZONS:
    ev[f"signed{h}"] = ev[f"adj{h}"] * ev["sign"]

# magnitude & liquidity buckets
ev["mag_q"] = pd.qcut(ev["surprise"].abs(), 4, labels=["q1(small)","q2","q3","q4(big)"])
ev["liq_q"] = pd.qcut(ev["dollar_vol"], 3, labels=["low-liq(small)","mid","high-liq(large)"])

def summ(df, col):
    s = df[col].dropna() * 100
    if len(s) == 0:
        return None
    return dict(n=len(s), mean=s.mean(), median=s.median(),
                hit=(s > 0).mean() * 100, t=s.mean() / (s.std(ddof=1) / np.sqrt(len(s))))

print(f"PEAD EVENTS: {len(ev):,} across {ev.ticker.nunique()} tickers, "
      f"{ev.earnings_date.min().date()} -> {ev.earnings_date.max().date()}\n")

print("=== Signed market-adjusted drift (return * sign(surprise)), all events ===")
print(f"{'horizon':>8} {'n':>7} {'mean%':>8} {'median%':>8} {'hit%':>6} {'t-stat':>7}")
for h in HORIZONS:
    r = summ(ev, f"signed{h}")
    print(f"{h:>7}d {r['n']:>7,} {r['mean']:>8.3f} {r['median']:>8.3f} {r['hit']:>6.1f} {r['t']:>7.2f}")

print("\n=== Signed drift by surprise magnitude quartile ===")
for h in HORIZONS:
    print(f"\n-- {h}-day --")
    for q, sub in ev.groupby("mag_q"):
        r = summ(sub, f"signed{h}")
        print(f"  {str(q):>10}: n={r['n']:>6,} mean={r['mean']:>7.3f}% hit={r['hit']:>5.1f}% t={r['t']:>6.2f}")

print("\n=== Signed drift by liquidity tercile (thesis: stronger in low-liq/small) ===")
for h in HORIZONS:
    print(f"\n-- {h}-day --")
    for q, sub in ev.groupby("liq_q"):
        r = summ(sub, f"signed{h}")
        print(f"  {str(q):>16}: n={r['n']:>6,} mean={r['mean']:>7.3f}% hit={r['hit']:>5.1f}% t={r['t']:>6.2f}")

print("\n=== Best cell: big surprise x low liquidity (the tradeable corner) ===")
corner = ev[(ev.mag_q == "q4(big)") & (ev.liq_q == "low-liq(small)")]
for h in HORIZONS:
    r = summ(corner, f"signed{h}")
    print(f"  {h:>2}d: n={r['n']:>5,} mean={r['mean']:>7.3f}% median={r['median']:>7.3f}% "
          f"hit={r['hit']:>5.1f}% t={r['t']:>6.2f}")

print("\n=== Long-only big BEATS in low-liq names (simplest small-account trade) ===")
beat = ev[(ev.mag_q == "q4(big)") & (ev.liq_q == "low-liq(small)") & (ev.sign > 0)]
for h in HORIZONS:
    r = summ(beat, f"adj{h}")   # raw market-adjusted (not signed) — actual long P&L
    print(f"  {h:>2}d: n={r['n']:>5,} mean={r['mean']:>7.3f}% median={r['median']:>7.3f}% "
          f"hit={r['hit']:>5.1f}% t={r['t']:>6.2f}")
