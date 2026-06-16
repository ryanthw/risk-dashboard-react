"""Credit-spread income backtest on SPY (small-account #5), real data only.

Design that needs only ONE option query per trade:
  * Entry: real DoltHub SPY chain on the entry date -> pick the expiration closest
    to TARGET_DTE, sell the short leg nearest TARGET_DELTA, buy the long leg ~WIDTH
    points further OTM (nearest real strike). Credit = real short mid - real long mid.
  * Exit: HOLD TO EXPIRATION. Settle from the REAL SPY close on the expiration date
    (prices.parquet). No exit chain, no interpolation, no modeled prices.
      bull put : profit/contract = credit - max(0, Kshort_put - S_exp) capped at width
      bear call: profit/contract = credit - max(0, S_exp - Kshort_call) capped at width
  * Return on max-risk = pnl / (width - credit).
Weekly entry cadence; both a bull-put and a bear-call each week (an iron-condor's two
wings, tradeable separately). Resumable: caches pulled chains to disk.
"""
import os, json, time, urllib.request, urllib.parse, warnings
import numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor, as_completed
warnings.filterwarnings("ignore")

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
OUT  = os.path.join(os.path.dirname(__file__), "..", "out")
BASE = "https://www.dolthub.com/api/v1alpha1/post-no-preference/options/master"
CACHE = os.path.join(OUT, "spy_entry_chains.json")   # {date: rows}
RESULT = os.path.join(OUT, "credit_spread_trades.parquet")

TARGET_DTE   = 30      # aim ~30 days to expiration
DTE_MIN, DTE_MAX = 18, 45
TARGET_DELTA = 0.20    # short-leg delta (|delta|)
WIDTH        = 5.0     # spread width in points (nearest real strike)
CADENCE      = 5       # entry every N trading days (weekly)

def dq(sql, tries=4):
    u = BASE + "?q=" + urllib.parse.quote(sql)
    for k in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "research"}), timeout=60)
            d = json.load(r)
            if d.get("query_execution_status") == "Success":
                return d["rows"]
            time.sleep(0.5 * (k + 1))
        except Exception:
            time.sleep(0.6 * (k + 1))
    return None

def mid(b, a):
    b = float(b) if b not in (None, "") else 0.0
    a = float(a) if a not in (None, "") else 0.0
    if a <= 0: return np.nan
    return (b + a) / 2.0 if b > 0 else a / 2.0

def fetch_chain(date):
    rows = dq(f"SELECT expiration,strike,call_put,bid,ask,delta FROM option_chain "
              f"WHERE act_symbol='SPY' AND date='{date}'")
    return rows  # None=error, []=nodata, list=ok

def pick_spread(rows, entry, cp):
    """cp in {'Put','Call'}. Returns (Kshort,Klong,credit,exp,dte,short_delta) or None."""
    df = pd.DataFrame([dict(exp=r["expiration"], K=float(r["strike"]), cp=r["call_put"],
                            d=float(r["delta"]) if r["delta"] else np.nan,
                            m=mid(r["bid"], r["ask"])) for r in rows])
    df = df[df.cp == cp].dropna(subset=["m", "d"])
    if df.empty: return None
    df["exp_dt"] = pd.to_datetime(df["exp"])
    df["dte"] = (df["exp_dt"] - pd.Timestamp(entry)).dt.days
    cand = df[(df.dte >= DTE_MIN) & (df.dte <= DTE_MAX)]
    if cand.empty: return None
    exp = cand.iloc[(cand.dte - TARGET_DTE).abs().argmin()]["exp"]
    leg = df[df.exp == exp].sort_values("K")
    short = leg.iloc[(leg.d.abs() - TARGET_DELTA).abs().argmin()]
    # long leg: ~WIDTH further OTM (puts: lower strike; calls: higher strike)
    if cp == "Put":
        otm = leg[leg.K <= short.K - 1]
        if otm.empty: return None
        longleg = otm.iloc[(otm.K - (short.K - WIDTH)).abs().argmin()]
    else:
        otm = leg[leg.K >= short.K + 1]
        if otm.empty: return None
        longleg = otm.iloc[(otm.K - (short.K + WIDTH)).abs().argmin()]
    credit = short.m - longleg.m
    width = abs(short.K - longleg.K)
    if credit <= 0 or width <= 0 or credit >= width: return None
    return dict(Kshort=short.K, Klong=longleg.K, credit=credit, width=width,
                exp=short.exp, dte=int(short.dte), short_delta=abs(short.d))

def main():
    px = pd.read_parquet(os.path.join(DATA, "prices.parquet"))
    px["Date"] = pd.to_datetime(px["Date"], utc=True).dt.tz_localize(None).dt.normalize()
    spy = px[px.ticker == "SPY"].sort_values("Date").reset_index(drop=True)
    sdates = spy["Date"].values
    sclose = dict(zip(spy["Date"].dt.date.astype(str), spy["Close"]))

    # entry dates: weekly cadence over the DoltHub coverage window
    cov = spy[(spy.Date >= "2020-06-15") & (spy.Date <= "2025-06-01")].reset_index(drop=True)
    entries = [pd.Timestamp(d).date().isoformat() for d in cov["Date"].values[::CADENCE]]

    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    todo = [e for e in entries if e not in cache]
    print(f"{len(entries)} candidate entries; {len(cache)} cached; {len(todo)} to fetch", flush=True)

    with ThreadPoolExecutor(max_workers=4) as exq:
        futs = {exq.submit(fetch_chain, e): e for e in todo}
        n = 0
        for f in as_completed(futs):
            e = futs[f]; n += 1
            rows = f.result()
            if rows is not None:
                cache[e] = rows
            if n % 50 == 0:
                json.dump(cache, open(CACHE, "w"))
                print(f"  fetched {n}/{len(todo)}", flush=True)
    json.dump(cache, open(CACHE, "w"))

    trades = []
    for entry, rows in cache.items():
        if not rows: continue
        for cp, side in [("Put", "bull_put"), ("Call", "bear_call")]:
            sp = pick_spread(rows, entry, cp)
            if sp is None: continue
            exp = sp["exp"]
            S = sclose.get(exp)
            if S is None:   # expiration not a SPY trading day in our panel -> snap to next
                cand = [d for d in sclose if d >= exp]
                if not cand: continue
                S = sclose[min(cand)]
            if cp == "Put":
                loss = max(0.0, sp["Kshort"] - S)
            else:
                loss = max(0.0, S - sp["Kshort"])
            loss = min(loss, sp["width"])
            pnl = sp["credit"] - loss
            risk = sp["width"] - sp["credit"]
            trades.append(dict(entry=entry, side=side, exp=exp, dte=sp["dte"],
                               Kshort=sp["Kshort"], Klong=sp["Klong"], width=sp["width"],
                               credit=sp["credit"], short_delta=sp["short_delta"],
                               S_exp=S, pnl=pnl, ret_risk=pnl / risk,
                               win=int(pnl > 0)))
    td = pd.DataFrame(trades)
    td.to_parquet(RESULT, index=False)

    def rep(df, label):
        if df.empty:
            print(f"{label}: no trades"); return
        r = df["ret_risk"] * 100
        pf = df.loc[df.pnl > 0, "pnl"].sum() / max(1e-9, -df.loc[df.pnl < 0, "pnl"].sum())
        t = r.mean() / (r.std(ddof=1) / np.sqrt(len(r)))
        print(f"{label:<22} n={len(df):>4}  win={df.win.mean()*100:>5.1f}%  "
              f"mean={r.mean():>6.2f}%  median={r.median():>6.2f}%  PF={pf:>4.2f}  "
              f"avg_credit={df.credit.mean():.2f}  t={t:>5.2f}")

    print(f"\nTRADES: {len(td)}  ({td.entry.min()} -> {td.entry.max()})  "
          f"avg DTE {td.dte.mean():.0f}, avg short|delta| {td.short_delta.mean():.2f}\n")
    rep(td, "ALL")
    rep(td[td.side == "bull_put"], "bull put")
    rep(td[td.side == "bear_call"], "bear call")
    print()
    td["year"] = td.entry.str[:4]
    for y, g in td.groupby("year"):
        rep(g, f"  {y}")
    # naive iron-condor = both wings each week
    print("\n=== Iron condor (both wings combined per entry) ===")
    ic = td.groupby("entry").agg(pnl=("pnl","sum"), credit=("credit","sum"),
                                 width=("width","mean")).reset_index()
    ic["risk"] = ic.width - ic.credit
    ic["ret_risk"] = ic.pnl / ic.risk
    ic["win"] = (ic.pnl > 0).astype(int)
    rep(ic.rename(columns={}), "iron condor")

if __name__ == "__main__":
    main()
