"""For each in-coverage earnings event, reconstruct from the DoltHub option_chain
(REAL EOD marks only -- no modeled/synthetic prices):
  - pre-earnings ATM straddle, a ~delta16 short strangle, ~delta5 long wings (entry)
  - their exit marks on the first available real trading day after earnings (T+1..T+3)
Exit prices are linearly interpolated *between real adjacent strikes* of the real
exit chain (no Black-Scholes, no modeled IV). Events without a real exit chain or
whose strikes are not bracketed by real data are skipped (gap). Resumable + threaded."""
import os, json, time, urllib.request, urllib.parse, warnings
import numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor, as_completed
warnings.filterwarnings("ignore")

OUT  = os.path.join(os.path.dirname(__file__), "..", "out")
DATA = os.path.join(os.path.dirname(__file__), "..", "data")
BASE = "https://www.dolthub.com/api/v1alpha1/post-no-preference/options/master"
COV_START = pd.Timestamp("2020-06-15")
RESULT = os.path.join(OUT, "options_legs.parquet")
DONE   = os.path.join(OUT, "_opt_done.json")

def dq(sql, tries=4):
    u = BASE + "?q=" + urllib.parse.quote(sql)
    for k in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "research"}), timeout=45)
            d = json.load(r)
            if d.get("query_execution_status") == "Success":
                return d["rows"]
            time.sleep(0.5 * (k + 1))
        except Exception:
            time.sleep(0.6 * (k + 1))
    return None   # persistent error (distinct from empty list)

def mid(b, a):
    b = float(b) if b not in (None, "") else 0.0
    a = float(a) if a not in (None, "") else 0.0
    if a <= 0: return np.nan
    return (b + a) / 2.0 if b > 0 else a / 2.0   # penny-wing: no bid -> half the (real) ask

def chain(sym, date, lo, hi):
    sql = (f"SELECT date,expiration,strike,call_put,bid,ask,vol,delta FROM option_chain "
           f"WHERE act_symbol='{sym}' AND date='{date}' AND strike BETWEEN {lo:.2f} AND {hi:.2f}")
    rows = dq(sql)
    if rows is None: return None
    if len(rows) == 0: return pd.DataFrame()
    out = [dict(exp=r["expiration"], strike=float(r["strike"]), cp=r["call_put"],
                vol=float(r["vol"]) if r["vol"] else np.nan,
                delta=float(r["delta"]) if r["delta"] else np.nan,
                mid=mid(r["bid"], r["ask"])) for r in rows]
    return pd.DataFrame(out)

def nearest(df, col, target):
    return df.loc[(df[col] - target).abs().idxmin()]

def interp_price(df_cp, K):
    """Linear interp of REAL mid vs strike at K; NaN if K not bracketed by real strikes."""
    d = df_cp.dropna(subset=["mid"]).sort_values("strike")
    if len(d) < 2: return np.nan
    s = d["strike"].values
    if K < s[0] or K > s[-1]: return np.nan   # do not extrapolate
    return float(np.interp(K, s, d["mid"].values))

def process(ev):
    """Returns (status, rec); status in {'ok','nodata','error'}. Real data only."""
    sym = ev["ticker"]; spot = ev["prior_close"]
    entry = pd.Timestamp(ev["entry_date"]).date().isoformat()
    exit_cands = ev["exit_cands"]            # list of ISO trading days T+1..T+3
    lo, hi = spot * 0.80, spot * 1.20
    ce = chain(sym, entry, lo, hi)
    if ce is None: return ("error", None)
    if ce.empty:   return ("nodata", None)
    ce["exp_dt"] = pd.to_datetime(ce["exp"])
    first_exit = pd.Timestamp(exit_cands[0])
    cand = ce[(ce["exp_dt"] > first_exit) & (ce["exp_dt"] <= pd.Timestamp(entry) + pd.Timedelta(days=45))]
    if cand.empty: return ("nodata", None)
    exp = cand["exp_dt"].min()
    leg = ce[ce["exp_dt"] == exp]
    calls = leg[leg["cp"] == "Call"].dropna(subset=["mid"])
    puts  = leg[leg["cp"] == "Put"].dropna(subset=["mid"])
    if calls.empty or puts.empty: return ("nodata", None)
    dte = (exp - pd.Timestamp(entry)).days
    common = set(calls.strike) & set(puts.strike)
    if not common: return ("nodata", None)
    atmK = min(common, key=lambda k: abs(k - spot))
    atm_c = calls[calls.strike == atmK].iloc[0]; atm_p = puts[puts.strike == atmK].iloc[0]
    sc = nearest(calls, "delta", 0.16); sp = nearest(puts, "delta", -0.16)
    lc = nearest(calls, "delta", 0.05); lp = nearest(puts, "delta", -0.05)

    # --- exit: first REAL exit chain among T+1..T+3 with the same expiration ----
    xleg = None; exit_used = None; api_err = False
    for ed in exit_cands:
        if pd.Timestamp(ed) >= exp:   # need time value remaining; same expiration must be alive
            continue
        xe = chain(sym, ed, lo, hi)
        if xe is None: api_err = True; continue
        if xe.empty: continue
        xe["exp_dt"] = pd.to_datetime(xe["exp"])
        cand_x = xe[xe["exp_dt"] == exp]
        if not cand_x.empty:
            xleg = cand_x; exit_used = ed; break
    if xleg is None:
        return ("error", None) if api_err else ("nodata", None)
    xcalls = xleg[xleg.cp == "Call"]; xputs = xleg[xleg.cp == "Put"]
    def xprice(cp, K):
        return interp_price(xcalls if cp == "Call" else xputs, K)
    exit_lag = exit_cands.index(exit_used) + 1
    rec = dict(
        ticker=sym, earnings_date=ev["earnings_date"], timing=ev["timing"], sector=ev["sector"],
        spot=spot, dte=dte, expiration=exp.date().isoformat(),
        exit_date=exit_used, exit_lag=exit_lag,
        atmK=atmK, atm_iv=np.nanmean([atm_c["vol"], atm_p["vol"]]),
        e_atm_c=atm_c["mid"], e_atm_p=atm_p["mid"],
        scK=sc.strike, spK=sp.strike, lcK=lc.strike, lpK=lp.strike,
        e_sc=sc["mid"], e_sp=sp["mid"], e_lc=lc["mid"], e_lp=lp["mid"],
        sc_delta=sc["delta"], sp_delta=sp["delta"], lc_delta=lc["delta"], lp_delta=lp["delta"],
        x_atm_c=xprice("Call", atmK), x_atm_p=xprice("Put", atmK),
        x_sc=xprice("Call", sc.strike), x_sp=xprice("Put", sp.strike),
        x_lc=xprice("Call", lc.strike), x_lp=xprice("Put", lp.strike),
        c2c=ev["c2c"], overnight=ev["overnight"], abs_c2c=ev["abs_c2c"], surprise=ev["surprise"],
    )
    return ("ok", rec)

def build_calendar():
    px = pd.read_parquet(os.path.join(DATA, "prices.parquet"))
    px["Date"] = pd.to_datetime(px["Date"], utc=True).dt.tz_localize(None).dt.normalize()
    cal = {tk: np.sort(g["Date"].values) for tk, g in px.groupby("ticker")}
    return cal

def main():
    ev = pd.read_parquet(os.path.join(OUT, "per_event.parquet"))
    ev = ev[ev["entry_date"] >= COV_START].copy()
    ev["eid"] = ev["ticker"] + "|" + pd.to_datetime(ev["earnings_date"]).dt.date.astype(str)
    cal = build_calendar()
    # attach the 3 real trading days after the (already-computed) exit_date
    recs = []
    for r in ev.to_dict("records"):
        days = cal.get(r["ticker"])
        if days is None: continue
        x0 = np.datetime64(pd.Timestamp(r["exit_date"]), "ns")
        i = int(np.searchsorted(days, x0))
        if i >= len(days): continue
        cands = [pd.Timestamp(days[j]).date().isoformat() for j in range(i, min(i + 3, len(days)))]
        r["exit_cands"] = cands
        recs.append(r)

    done = set(json.load(open(DONE))) if os.path.exists(DONE) else set()
    todo = [r for r in recs if r["eid"] not in done]
    print(f"{len(recs)} events in coverage; {len(done)} done; {len(todo)} to fetch", flush=True)
    results = [pd.read_parquet(RESULT)] if os.path.exists(RESULT) else []
    buf, n, errs = [], 0, 0
    with ThreadPoolExecutor(max_workers=4) as exq:
        futs = {exq.submit(process, r): r["eid"] for r in todo}
        for f in as_completed(futs):
            eid = futs[f]; n += 1
            try:
                status, rec = f.result()
            except Exception:
                status, rec = "error", None
            if status == "ok":
                buf.append(rec); done.add(eid)
            elif status == "nodata":
                done.add(eid)
            else:
                errs += 1
            if n % 250 == 0:
                if buf: results.append(pd.DataFrame(buf)); buf = []
                pd.concat(results, ignore_index=True).to_parquet(RESULT, index=False)
                json.dump(sorted(done), open(DONE, "w"))
                tot = sum(len(x) for x in results)
                print(f"  {n}/{len(todo)} processed, {tot} legs, {errs} transient errs", flush=True)
    if buf: results.append(pd.DataFrame(buf))
    if results: pd.concat(results, ignore_index=True).to_parquet(RESULT, index=False)
    json.dump(sorted(done), open(DONE, "w"))
    tot = sum(len(x) for x in results)
    print(f"DONE_OPT: {n} processed, {tot} total legs, {errs} errs -> {RESULT}", flush=True)

if __name__ == "__main__":
    main()
