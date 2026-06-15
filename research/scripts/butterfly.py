"""Iron BUTTERFLY analysis (short ATM straddle body + long OTM wings) vs the
straddle and the iron condor. Reuses the real cached legs in trades_enriched.parquet.
Also writes a per-ticker historical reliability cache for the scanner."""
import os, json, warnings
import numpy as np, pandas as pd
warnings.filterwarnings("ignore")
pd.set_option("display.width", 170)
OUT = os.path.join(os.path.dirname(__file__), "..", "out")
df = pd.read_parquet(os.path.join(OUT, "trades_enriched.parquet"))
df["earnings_date"] = pd.to_datetime(df["earnings_date"])

def build_fly(tag, callK, putK, e_lc, e_lp, x_lc, x_lp):
    """short ATM straddle + long wings (callK/putK). Returns columns into df."""
    credit = (df.e_atm_c + df.e_atm_p) - (e_lc + e_lp)
    exit_  = (df.x_atm_c + df.x_atm_p) - (x_lc + x_lp)
    pnl    = credit - exit_
    cw = (callK - df.atmK); pw = (df.atmK - putK)
    width = np.maximum(cw, pw)
    maxloss = (width - credit).clip(lower=0.01)
    ratio = credit / width
    ok = (width > 0) & np.isfinite(width) & (callK > df.atmK) & (putK < df.atmK) & ratio.between(0.05, 0.95)
    df[f"{tag}_credit"]=credit; df[f"{tag}_pnl"]=pnl; df[f"{tag}_width"]=width
    df[f"{tag}_maxloss"]=maxloss.where(ok); df[f"{tag}_ror"]=(pnl/maxloss).where(ok)
    df[f"{tag}_ok"]=ok

# wide fly: long Δ5 wings ; tight fly: long Δ16 wings
build_fly("ibf",  df.lcK, df.lpK, df.e_lc, df.e_lp, df.x_lc, df.x_lp)
build_fly("ibft", df.scK, df.spK, df.e_sc, df.e_sp, df.x_sc, df.x_sp)
# recompute condor ror for reference (same validity as backtest)
df["ic_ror"] = (df.ic_pnl / df.ic_maxloss)

def stats(s, label):
    s = s.dropna()
    if not len(s): print(f"{label:34} (no data)"); return
    win=(s>0).mean(); aw=s[s>0].mean(); al=s[s<0].mean() if (s<0).any() else 0
    pf = s[s>0].sum()/-s[s<0].sum() if (s<0).any() else np.inf
    print(f"{label:34} n={len(s):5} win={win*100:4.1f}% mean={s.mean():+.3f} med={s.median():+.3f} "
          f"avgW={aw:+.3f} avgL={al:+.3f} PF={pf:4.2f} edge/sd={s.mean()/s.std():+.3f}")

print("=== STRUCTURE COMPARISON (per-trade, return on max-risk; full real sample) ===")
stats(df.straddle_pnl/(0.18*df.spot), "Short straddle (risk=18% notl)")
stats(df.ic_ror,   "Iron CONDOR  Δ16 body / Δ5 wings")
stats(df.ibf_ror,  "Iron BUTTERFLY ATM / Δ5 wings (wide)")
stats(df.ibft_ror, "Iron BUTTERFLY ATM / Δ16 wings (tight)")

print("\n=== T+1-only (cleanest exit) ===")
d1=df[df.exit_lag==1]
stats(d1.ic_ror,   "Iron CONDOR (T+1)")
stats(d1.ibf_ror,  "Iron BUTTERFLY Δ5 (T+1)")
stats(d1.ibft_ror, "Iron BUTTERFLY Δ16 (T+1)")

print("\n=== Butterfly Δ5: credit as % of width & as % of a same-strike straddle ===")
ok=df.ibf_ok
print(f"  credit/width median={ (df.ibf_credit/df.ibf_width)[ok].median():.2f}  "
      f"credit/straddle median={ (df.ibf_credit/(df.e_atm_c+df.e_atm_p))[ok].median():.2f}  "
      f"(fly keeps ~this fraction of the naked straddle premium)")

print("\n=== ROBUSTNESS BY YEAR (mean return on risk) ===")
df["year"]=df.earnings_date.dt.year
yr=df.groupby("year").agg(n=("ibf_ror","size"),
    condor=("ic_ror","mean"), fly_d5=("ibf_ror","mean"), fly_d16=("ibft_ror","mean"),
    fly_d5_win=("ibf_ror", lambda s:(s>0).mean()))
print(yr.assign(condor=yr.condor.round(3),fly_d5=yr.fly_d5.round(3),fly_d16=yr.fly_d16.round(3),
                fly_d5_win=(yr.fly_d5_win*100).round(0)).to_string())

print("\n=== SIZING (iron butterfly Δ5) ===")
r=df.ibf_ror.dropna().clip(-1,1).values
p=(r>0).mean(); b=r[r>0].mean()/-r[r<0].mean()
print(f"  per-trade mean={r.mean():+.3f} sd={r.std():.3f} win={p*100:.1f}% payoff b={b:.2f} p1={np.percentile(r,1):+.2f}")
rng=np.random.default_rng(7)
for f in [0.01,0.02,0.03,0.05]:
    idx=rng.integers(0,len(r),size=(4000,400)); eq=np.exp(np.cumsum(np.log(np.clip(1+f*r[idx],1e-6,None)),axis=1))
    dd=(eq/np.maximum.accumulate(eq,axis=1)-1).min(axis=1)
    print(f"  f={f*100:.0f}%/trade: medianCAGR~{eq[:,-1].mean()**0.5:.2f}x  medMaxDD={np.median(dd)*100:.0f}%  worst1%DD={np.percentile(dd,1)*100:.0f}%")

# ---- per-ticker reliability cache for the scanner ----
print("\n=== writing per-ticker reliability cache ===")
g=df.groupby("ticker")
rel=g.agg(n=("ibf_ror","count"),
          fly_win=("ibf_ror", lambda s:(s>0).mean()),
          fly_mean_ror=("ibf_ror","mean"),
          straddle_win=("straddle_ret_prem", lambda s:(s>0).mean()),
          straddle_mean=("straddle_ret_prem","mean"),
          avg_implied=("implied_move","mean"),
          avg_actual=("abs_c2c","mean"),
          atm_iv=("atm_iv","mean")).reset_index()
rel["premium_richness"]=rel.avg_implied/rel.avg_actual
rel=rel[rel.n>=3].sort_values("fly_mean_ror",ascending=False)
rel.round(4).to_json(os.path.join(OUT,"ticker_reliability.json"),orient="records")
rel.round(4).to_csv(os.path.join(OUT,"ticker_reliability.csv"),index=False)
print(f"  saved {len(rel)} tickers -> out/ticker_reliability.json/.csv")
print("  top 8 by fly mean ror:")
print(rel.head(8)[["ticker","n","fly_win","fly_mean_ror","straddle_win","premium_richness"]].round(3).to_string(index=False))
df.to_parquet(os.path.join(OUT,"trades_enriched.parquet"),index=False)
