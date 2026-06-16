"""Dual / time-series momentum on a liquid ETF universe (small-account #B).

Generalizable, robust, deploys as a CORE book at any dollar size (fractional ETFs,
monthly rebalance, 1-8 overnight positions, $0 commission). Tests whether the
textbook momentum edge beats buy-and-hold SPY on a risk-adjusted basis here.

Strategies (month-end rebalance, signal at t -> hold t..t+1, no look-ahead):
  1. Buy & hold SPY                         (benchmark)
  2. 60/40 SPY/AGG                          (lazy benchmark)
  3. TS-momentum sleeve  : equal-weight the risk assets whose 12m return beats T-bill;
                           the rest of the book sits in BIL (cash).
  4. Dual momentum (GEM) : relative winner of {SPY, EFA}; if it beats T-bill hold it,
                           else hold AGG. Single rotating position (Antonacci).
  5. Top-3 cross-sectional: hold the 3 highest-12m-momentum risk assets that also beat
                           T-bill; empty slots -> BIL.
Costs: 5 bps per unit turnover at each rebalance (ETFs are liquid).
"""
import os, json, warnings
import numpy as np, pandas as pd
warnings.filterwarnings("ignore")
DATA = os.path.join(os.path.dirname(__file__), "..", "data")
OUT  = os.path.join(os.path.dirname(__file__), "..", "out")

# --- rebuild a clean wide Close panel from the (block-diagonal) ETF parquet ---
raw = pd.read_parquet(os.path.join(DATA, "etf_prices.parquet"))
raw.columns = [c if isinstance(c, tuple) else eval(c) for c in raw.columns]  # tuple cols
date = raw[("Date", "")]
tick_col = raw[("ticker", "")]
closes = {}
for col in raw.columns:
    if isinstance(col, tuple) and col[0] == "Close" and col[1]:
        t = col[1]
        s = pd.Series(raw[col].values, index=date.values)
        closes[t] = s[tick_col.values == t].dropna()   # rows belonging to this ticker
px = pd.DataFrame(closes).sort_index()
px.index = pd.to_datetime(px.index)
me = px.resample("ME").last()                            # month-end closes
LOOKBACK = 12
mom = me / me.shift(LOOKBACK) - 1.0                       # trailing 12m total return
rf_m = me["BIL"] / me["BIL"].shift(1) - 1.0              # monthly cash return
mom_rf = me["BIL"] / me["BIL"].shift(LOOKBACK) - 1.0     # 12m cash return (absolute filter)
ret_next = me.pct_change().shift(-1)                      # realized t -> t+1 return
COST = 0.0005

RISK = ["SPY","QQQ","IWM","EFA","EEM","TLT","IEF","LQD","HYG","GLD","DBC","VNQ"]
RISK = [t for t in RISK if t in me.columns]

def run(weight_fn, start):
    """weight_fn(month_ts) -> dict ticker->weight (sums<=1; rest cash). Returns monthly ret series."""
    idx = me.index[(me.index >= start)]
    rets, prev = [], {}
    for t in idx:
        if t not in ret_next.index: continue
        w = weight_fn(t)
        if w is None: continue
        cashw = 1.0 - sum(w.values())
        r = cashw * (rf_m.get(t, 0.0) if not np.isnan(rf_m.get(t, np.nan)) else 0.0)
        for tk, wt in w.items():
            rr = ret_next.at[t, tk]
            if np.isnan(rr): rr = 0.0
            r += wt * rr
        turn = sum(abs(w.get(k, 0) - prev.get(k, 0)) for k in set(w) | set(prev))
        r -= COST * turn
        rets.append((t, r)); prev = w
    return pd.Series(dict(rets))

def w_spy(t):  return {"SPY": 1.0}
def w_6040(t): return {"SPY": 0.6, "AGG": 0.4} if "AGG" in me.columns else {"SPY":0.6}
def w_tsmom(t):
    elig = [a for a in RISK if not np.isnan(mom.at[t, a]) and mom.at[t, a] > mom_rf.get(t, 0)]
    if not elig: return {}
    return {a: 1.0/len(RISK) for a in elig}          # fixed 1/N slots; non-elig -> cash
def w_gem(t):
    pair = [a for a in ["SPY","EFA"] if not np.isnan(mom.at[t, a])]
    if not pair: return None
    best = max(pair, key=lambda a: mom.at[t, a])
    if mom.at[t, best] > mom_rf.get(t, 0): return {best: 1.0}
    return {"AGG": 1.0} if "AGG" in me.columns else {}
def w_top3(t):
    cand = [(a, mom.at[t, a]) for a in RISK if not np.isnan(mom.at[t, a]) and mom.at[t, a] > mom_rf.get(t, 0)]
    cand = sorted(cand, key=lambda x: -x[1])[:3]
    return {a: 1.0/3 for a, _ in cand} if cand else {}

START = pd.Timestamp("2008-01-31")
strats = {"Buy&Hold SPY": w_spy, "60/40 SPY-AGG": w_6040,
          "TS-momentum sleeve": w_tsmom, "Dual momentum GEM": w_gem, "Top-3 X-sectional": w_top3}
series = {n: run(f, START) for n, f in strats.items()}

def stats(r):
    r = r.dropna()
    n = len(r); ann = 12
    cagr = (1 + r).prod() ** (ann / n) - 1
    vol = r.std() * np.sqrt(ann)
    sharpe = (r.mean() - rf_m.reindex(r.index).fillna(0).mean()) / r.std() * np.sqrt(ann)
    eq = (1 + r).cumprod()
    dd = (eq / eq.cummax() - 1).min()
    return cagr, vol, sharpe, dd, (r > 0).mean(), n

common = min(s.dropna().index.min() for s in series.values())
print(f"ETF momentum study — monthly, {LOOKBACK}m lookback, 5bps cost, "
      f"{common.date()} -> {max(s.dropna().index.max() for s in series.values()).date()}\n")
print(f"{'strategy':<20}{'CAGR':>7}{'vol':>7}{'Sharpe':>8}{'maxDD':>8}{'win%':>7}{'n':>5}")
for n, s in series.items():
    c, v, sh, dd, w, nn = stats(s)
    print(f"{n:<20}{c*100:>6.1f}%{v*100:>6.1f}%{sh:>8.2f}{dd*100:>7.0f}%{w*100:>6.0f}%{nn:>5}")

# save equity curves + per-year for the writeup
eqs = pd.DataFrame({n: (1 + s.dropna()).cumprod() for n, s in series.items()})
eqs.to_csv(os.path.join(OUT, "momentum_equity.csv"))
print("\nPer-calendar-year total return (%):")
yr = pd.DataFrame({n: s.dropna() for n, s in series.items()})
yr_ret = (yr.groupby(yr.index.year).apply(lambda g: (1 + g).prod() - 1) * 100).round(1)
print(yr_ret.to_string())
