"""Cost-aware PEAD — does the drift survive the bid-ask spread of illiquid names?

PEAD's edge is strongest exactly where spreads are widest (small, low-liquidity
names). This nets the gross drift against a REAL, data-derived transaction cost:
the Corwin-Schultz (2012) high-low bid-ask spread estimator, computed per name from
its own daily High/Low — no quote feed, no assumed cost. A long round-trip (in at
the reaction close, out N days later) crosses ~one full proportional spread, so we
subtract one CS spread from the signed drift to get NET edge.

Outputs net EV for the tradeable corner and a per-name screen feed for a scanner mode.
"""
import os, warnings
import numpy as np, pandas as pd
warnings.filterwarnings("ignore")

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
OUT  = os.path.join(os.path.dirname(__file__), "..", "out")
HORIZONS = [1, 5, 20]
LIQ_WINDOW = 60
DEN = 3 - 2 * np.sqrt(2)

def corwin_schultz(H, L):
    """Per-day proportional bid-ask spread estimate (aligned to day t, using t & t+1)."""
    H = np.asarray(H, float); L = np.asarray(L, float)
    with np.errstate(divide="ignore", invalid="ignore"):
        ln_hl = np.log(H / L)
        ln_hl2 = ln_hl ** 2
        beta = ln_hl2[:-1] + ln_hl2[1:]                      # 2-day sum
        hi2 = np.maximum(H[:-1], H[1:]); lo2 = np.minimum(L[:-1], L[1:])
        gamma = np.log(hi2 / lo2) ** 2
        alpha = (np.sqrt(2 * beta) - np.sqrt(beta)) / DEN - np.sqrt(gamma / DEN)
        S = 2 * (np.exp(alpha) - 1) / (1 + np.exp(alpha))
    S = np.clip(S, 0, None)
    out = np.full(len(H), np.nan)
    out[:-1] = S                                              # S[t] uses days t, t+1
    return out

# --- earnings + prices (same conventions as pead.py) ---------------------
earn = pd.read_parquet(os.path.join(DATA, "earnings_dates.parquet")).rename(columns={"Earnings Date": "ts"})
earn["ts"] = pd.to_datetime(earn["ts"], utc=True).dt.tz_convert("America/New_York")
earn = earn[earn["Event Type"].fillna("Earnings").str.contains("Earnings", case=False, na=True)]
earn["cal_date"] = earn["ts"].dt.normalize().dt.tz_localize(None)
hour = earn["ts"].dt.hour + earn["ts"].dt.minute / 60.0
earn["timing"] = hour.map(lambda h: "AMC" if h >= 16 else ("BMO" if h <= 9.5 else ("UNK" if 11.5 <= h <= 12.5 else "DMT")))
earn["surprise"] = pd.to_numeric(earn["Surprise(%)"], errors="coerce")
earn = earn.dropna(subset=["surprise"])

px = pd.read_parquet(os.path.join(DATA, "prices.parquet"))
px["Date"] = pd.to_datetime(px["Date"], utc=True).dt.tz_localize(None).dt.normalize()
px = px.sort_values(["ticker", "Date"]).drop_duplicates(["ticker", "Date"])
spy = px[px.ticker == "SPY"].reset_index(drop=True)
spy_close = spy["Close"].values
spy_pos = {d: i for i, d in enumerate(spy["Date"].values)}

rows = []
for tk, g in px.groupby("ticker"):
    if tk == "SPY": continue
    g = g.reset_index(drop=True)
    dates = g["Date"].values; c = g["Close"].values; v = g["Volume"].values
    cs = corwin_schultz(g["High"].values, g["Low"].values)
    dollar_vol = c * v
    ev = earn[earn.ticker == tk]
    for _, e in ev.iterrows():
        d = np.datetime64(e["cal_date"], "ns")
        idxs = int(np.searchsorted(dates, d))
        if idxs >= len(dates): continue
        react_i = idxs + 1 if e["timing"] == "AMC" else idxs
        if react_i < LIQ_WINDOW or react_i >= len(dates): continue
        entry_close = c[react_i]; entry_date = dates[react_i]
        if entry_close <= 0 or entry_date not in spy_pos: continue
        si = spy_pos[entry_date]
        liq = np.median(dollar_vol[react_i - LIQ_WINDOW:react_i])
        spread = np.nanmedian(cs[react_i - LIQ_WINDOW:react_i])   # est proportional spread
        rec = dict(ticker=tk, earnings_date=pd.Timestamp(dates[idxs]), timing=e["timing"],
                   entry_date=pd.Timestamp(entry_date), surprise=e["surprise"],
                   dollar_vol=liq, spread=spread)
        ok = True
        for h in HORIZONS:
            if react_i + h >= len(dates) or si + h >= len(spy_close): ok = False; break
            stock_ret = c[react_i + h] / entry_close - 1.0
            mkt_ret = spy_close[si + h] / spy_close[si] - 1.0
            rec[f"adj{h}"] = stock_ret - mkt_ret
        if ok: rows.append(rec)

ev = pd.DataFrame(rows)
ev["sign"] = np.sign(ev["surprise"]); ev = ev[ev["sign"] != 0]
for h in HORIZONS:
    ev[f"signed{h}"] = ev[f"adj{h}"] * ev["sign"]
    ev[f"net{h}"] = ev[f"signed{h}"] - ev["spread"]      # subtract one round-trip spread
ev["mag_q"] = pd.qcut(ev["surprise"].abs(), 4, labels=["q1","q2","q3","q4(big)"])
ev["liq_q"] = pd.qcut(ev["dollar_vol"], 3, labels=["low-liq(small)","mid","high-liq(large)"])
ev.to_parquet(os.path.join(OUT, "pead_cost_events.parquet"), index=False)

def summ(df, col):
    s = df[col].dropna() * 100
    return dict(n=len(s), mean=s.mean(), median=s.median(), hit=(s > 0).mean()*100,
                t=s.mean()/(s.std(ddof=1)/np.sqrt(len(s))) if len(s) > 1 else np.nan)

print(f"COST-AWARE PEAD: {len(ev):,} events, {ev.ticker.nunique()} tickers")
print(f"Corwin-Schultz spread estimate: median {ev.spread.median()*100:.2f}%  "
      f"low-liq {ev[ev.liq_q=='low-liq(small)'].spread.median()*100:.2f}%  "
      f"high-liq {ev[ev.liq_q=='high-liq(large)'].spread.median()*100:.2f}%\n")

print("=== GROSS vs NET signed drift, big-surprise x low-liquidity corner ===")
corner = ev[(ev.mag_q == "q4(big)") & (ev.liq_q == "low-liq(small)")]
print(f"{'h':>3} {'gross%':>8} {'spread%':>8} {'NET%':>8} {'net_hit%':>9} {'net_t':>7}")
for h in HORIZONS:
    g = summ(corner, f"signed{h}"); n = summ(corner, f"net{h}")
    print(f"{h:>2}d {g['mean']:>8.3f} {corner.spread.median()*100:>8.3f} "
          f"{n['mean']:>8.3f} {n['hit']:>9.1f} {n['t']:>7.2f}")

print("\n=== NET edge by liquidity tercile (does illiquidity pay for itself?) ===")
for h in [5, 20]:
    print(f"-- {h}d --")
    for q, sub in ev.groupby("liq_q"):
        g = summ(sub, f"signed{h}"); n = summ(sub, f"net{h}")
        print(f"  {str(q):>16}: gross={g['mean']:>6.3f}%  spread={sub.spread.median()*100:>5.2f}%  "
              f"NET={n['mean']:>6.3f}%  t={n['t']:>5.2f}")

print("\n=== NET by surprise-magnitude within low-liq names (where to set the threshold) ===")
ll = ev[ev.liq_q == "low-liq(small)"]
for h in [5, 20]:
    print(f"-- {h}d --")
    for q, sub in ll.groupby("mag_q"):
        n = summ(sub, f"net{h}")
        print(f"  {str(q):>8}: n={n['n']:>5} NET={n['mean']:>6.3f}%  hit={n['hit']:>5.1f}%  t={n['t']:>5.2f}")
