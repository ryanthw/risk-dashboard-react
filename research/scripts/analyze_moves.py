"""Build the per-event actual-move dataset from cached earnings dates + prices,
then characterize the distribution of earnings moves across the S&P 500."""
import os, warnings
import numpy as np
import pandas as pd
warnings.filterwarnings("ignore")

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
OUT  = os.path.join(os.path.dirname(__file__), "..", "out")
os.makedirs(OUT, exist_ok=True)

uni = pd.read_csv(os.path.join(DATA, "universe.csv"))
sec = dict(zip(uni.ticker, uni.sector))

earn = pd.read_parquet(os.path.join(DATA, "earnings_dates.parquet"))
px   = pd.read_parquet(os.path.join(DATA, "prices.parquet"))

# --- normalize earnings table -------------------------------------------
# reset_index produced a column for the old index; find the datetime col
dtcol = [c for c in earn.columns if "Earnings Date" in c or c == "index"]
dtcol = dtcol[0] if dtcol else earn.columns[0]
earn = earn.rename(columns={dtcol: "ts"})
earn["ts"] = pd.to_datetime(earn["ts"], utc=True).dt.tz_convert("America/New_York")
earn = earn[earn.get("Event Type", "Earnings").fillna("Earnings").str.contains("Earnings", case=False, na=True)]
earn["cal_date"] = earn["ts"].dt.normalize().dt.tz_localize(None)
hour = earn["ts"].dt.hour + earn["ts"].dt.minute / 60.0
def timing(h):
    if h >= 16: return "AMC"
    if h <= 9.5: return "BMO"
    if 11.5 <= h <= 12.5: return "UNK"   # yfinance default-noon = unspecified
    return "DMT"
earn["timing"] = hour.map(timing)
earn["surprise"] = pd.to_numeric(earn.get("Surprise(%)"), errors="coerce")

# --- price panel ---------------------------------------------------------
px["Date"] = pd.to_datetime(px["Date"], utc=True).dt.tz_localize(None).dt.normalize()
px = px.sort_values(["ticker", "Date"]).drop_duplicates(["ticker", "Date"])

rows = []
for tk, g in px.groupby("ticker"):
    g = g.reset_index(drop=True)
    dates = g["Date"].values
    o = g["Open"].values; c = g["Close"].values; v = g["Volume"].values
    pos = {d: i for i, d in enumerate(dates)}
    # rolling non-event realized vol of daily close-to-close (annualization done later)
    ret = np.diff(np.log(c), prepend=np.log(c[0]))
    ev = earn[earn.ticker == tk]
    for _, e in ev.iterrows():
        d = np.datetime64(e["cal_date"], "ns")
        # find entry/exit trading days
        # AMC/UNK: announce-day is the cal_date trading day (or next trading day if holiday)
        # BMO: announce before open on cal_date -> entry is prior trading day
        idxs = np.searchsorted(dates, d)
        if idxs >= len(dates):
            continue
        # snap cal_date to a trading day index
        if dates[idxs] != d:
            # cal_date not a trading day; for AMC use next trading day, for BMO use this (next) day
            day_i = idxs if idxs < len(dates) else None
        else:
            day_i = idxs
        if day_i is None or day_i < 1 or day_i >= len(dates) - 1:
            continue
        t = e["timing"]
        if t in ("AMC", "UNK", "DMT"):
            entry_i, post_i = day_i, day_i + 1
        else:  # BMO
            entry_i, post_i = day_i - 1, day_i
        if post_i >= len(dates):
            continue
        prior_close = c[entry_i]
        nxt_open = o[post_i]; nxt_close = c[post_i]
        if prior_close <= 0 or nxt_open <= 0:
            continue
        overnight = nxt_open / prior_close - 1.0
        c2c = nxt_close / prior_close - 1.0
        # trailing realized daily vol (60d) excluding the event window, as a baseline
        lo = max(0, entry_i - 60)
        base_vol = np.std(ret[lo:entry_i]) if entry_i - lo > 10 else np.nan
        rows.append(dict(
            ticker=tk, sector=sec.get(tk), earnings_date=pd.Timestamp(dates[day_i]),
            timing=t, entry_date=pd.Timestamp(dates[entry_i]), exit_date=pd.Timestamp(dates[post_i]),
            prior_close=prior_close, next_open=nxt_open, next_close=nxt_close,
            overnight=overnight, c2c=c2c,
            abs_overnight=abs(overnight), abs_c2c=abs(c2c),
            base_daily_vol=base_vol, surprise=e["surprise"], avg_dollar_vol=np.nan,
        ))

ev = pd.DataFrame(rows)
ev.to_parquet(os.path.join(OUT, "per_event.parquet"), index=False)

# --- characterize --------------------------------------------------------
def pct(s, p): return np.nanpercentile(s, p)
print(f"EVENTS: {len(ev):,} across {ev.ticker.nunique()} tickers, "
      f"{ev.earnings_date.min().date()} -> {ev.earnings_date.max().date()}")
print("\nTiming mix:")
print(ev.timing.value_counts())
for col in ["abs_c2c", "abs_overnight"]:
    s = ev[col].dropna() * 100
    print(f"\n{col} (% abs move): mean={s.mean():.2f}  median={s.median():.2f}  "
          f"p75={pct(s,75):.2f}  p90={pct(s,90):.2f}  p95={pct(s,95):.2f}  p99={pct(s,99):.2f}  max={s.max():.2f}")

# event move vs baseline daily vol -> "how many sigma is an earnings day"
ev["c2c_sigma"] = ev["abs_c2c"] / ev["base_daily_vol"]
print(f"\nEarnings day move in units of normal daily sigma: median={ev.c2c_sigma.median():.1f}x  mean={ev.c2c_sigma.mean():.1f}x")

# persistence: does a name's past avg move predict its next move?
ev = ev.sort_values(["ticker", "earnings_date"])
ev["roll_avg_abs"] = ev.groupby("ticker")["abs_c2c"].transform(lambda s: s.shift().expanding(min_periods=3).mean())
corr = ev[["roll_avg_abs", "abs_c2c"]].dropna().corr().iloc[0, 1]
print(f"\nPersistence: corr(prior-avg |move|, next |move|) = {corr:.3f}  (n={ev[['roll_avg_abs','abs_c2c']].dropna().shape[0]:,})")

# by sector
print("\nMedian |c2c| move by sector (%):")
print((ev.groupby("sector")["abs_c2c"].median() * 100).sort_values(ascending=False).round(2).to_string())
