"""Does the PROVEN iron-condor edge actually deploy at $5-7.5k?

The condor edge is real (REPORT: PF 2.4, positive every year). The REPORT also says
the variance control comes from diversifying across k=20-40 concurrent trades. This
script tests whether a small account can REACH that k, given two small-account frictions
the REPORT didn't price:
  1. Options trade in 1-contract units (NOT fractionable) -> the minimum bet is
     maxloss*100 dollars; if that already exceeds your per-trade risk budget you are
     stuck at 1 contract and OVER-risked.
  2. Buying-power: each defined-risk condor ties up its max loss; a small account runs
     out of BP (and of affordable, same-week names) long before k=20.
Then Monte-Carlos the equity path at the k a small account can actually achieve vs the
k=20-40 ideal, using the REAL per-trade condor return distribution.
"""
import os, warnings
import numpy as np, pandas as pd
warnings.filterwarnings("ignore")
rng = np.random.default_rng(7)
OUT = os.path.join(os.path.dirname(__file__), "..", "out")

df = pd.read_parquet(os.path.join(OUT, "trades_enriched.parquet"))
df = df[df.ic_ok == True].copy()
df["maxloss_usd"] = df.ic_maxloss * 100.0          # $ risk per 1 contract
ic_ret = (df.ic_pnl / df.ic_maxloss).dropna().clip(-1.0, 1.0).values   # return on risk
ACCOUNTS = [5000, 6250, 7500]
BP_CAP = 0.40            # cap total defined-risk at 40% of equity at any time
RISK_TGT = 0.02         # REPORT's recommended per-trade risk

print(f"REAL iron-condor trades: n={len(df)}, "
      f"per-trade return mean={ic_ret.mean():+.3f} sd={ic_ret.std():.3f} win={(ic_ret>0).mean()*100:.1f}%\n")

ml = df.maxloss_usd
print("=== Per-contract dollar max-loss (the minimum bet; options aren't fractionable) ===")
print(f"  median ${ml.median():.0f}   p10 ${ml.quantile(.1):.0f}   p25 ${ml.quantile(.25):.0f}   "
      f"p75 ${ml.quantile(.75):.0f}   p90 ${ml.quantile(.9):.0f}")

print("\n=== Forced per-trade risk if you trade 1 contract (vs 2% target) ===")
for acct in ACCOUNTS:
    pct = (ml / acct) * 100
    fit2 = (ml <= RISK_TGT * acct).mean() * 100
    print(f"  ${acct:>5}: 1-contract risk = median {pct.median():.1f}%  p25 {pct.quantile(.25):.1f}%  "
          f"p75 {pct.quantile(.75):.1f}% of account   |  only {fit2:.0f}% of trades fit the 2% budget")

# --- achievable concurrency: affordable names per earnings week, capped by BP ---
df["week"] = pd.to_datetime(df.earnings_date).dt.to_period("W")
print("\n=== Achievable concurrent k per earnings week (median over weeks) ===")
print("  (affordable = 1-contract maxloss <= per-trade budget; also capped by 40% BP)")
for acct in ACCOUNTS:
    budget = RISK_TGT * acct
    aff = df[df.maxloss_usd <= budget]
    if len(aff) == 0:
        print(f"  ${acct:>5}: ~0 names fit a 2% budget -> cannot run the strategy as designed")
        continue
    per_week = aff.groupby("week").ticker.nunique()
    bp_cap_k = int(BP_CAP * acct / aff.maxloss_usd.median())
    print(f"  ${acct:>5}: affordable names/wk median={per_week.median():.0f} "
          f"(p75={per_week.quantile(.75):.0f}); BP caps at k={bp_cap_k}  "
          f"-> realistic k ~ {min(int(per_week.median()), bp_cap_k)}")

# loosen to a 3% and 5% budget to show the tradeoff
print("\n=== If you accept higher per-trade risk, how many names become affordable? ===")
for acct in ACCOUNTS:
    line = [f"  ${acct:>5}:"]
    for tgt in [0.02, 0.03, 0.05, 0.08]:
        aff = df[df.maxloss_usd <= tgt * acct]
        pw = aff.groupby("week").ticker.nunique().median() if len(aff) else 0
        line.append(f"{int(tgt*100)}%->k~{pw:.0f}")
    print("  ".join(line))

# --- Monte-Carlo with REAL forced sizing (the honest version) ---
# Options are indivisible: each trade risks its actual maxloss/account, NOT a dialed f.
# Sample (maxloss_fraction, return) JOINTLY per real trade so big bets keep their real P&L.
ml_usd = df.maxloss_usd.values
ic_r   = (df.ic_pnl / df.ic_maxloss).clip(-1.0, 1.0).values
ok = ~np.isnan(ic_r)
ml_usd, ic_r = ml_usd[ok], ic_r[ok]

def forced_path(account, k, n_periods=100, n_paths=6000, affordable_pct=None):
    """Each week trade k condors at their REAL dollar risk on this account size.
    affordable_pct: if set, only trade names whose 1-contract maxloss <= pct*account."""
    mask = np.ones(len(ml_usd), bool) if affordable_pct is None else (ml_usd <= affordable_pct*account)
    ml_, r_ = ml_usd[mask], ic_r[mask]
    if len(ml_) < k: return None, None, len(ml_)
    idx = rng.integers(0, len(ml_), size=(n_paths, n_periods, k))
    f = ml_[idx] / account                       # real fraction risked per trade
    step_ret = (f * r_[idx]).sum(axis=2)          # summed P&L fraction across the k trades
    eq = np.exp(np.cumsum(np.log(np.clip(1.0 + step_ret, 1e-6, None)), axis=1))
    dd = (eq / np.maximum.accumulate(eq, axis=1) - 1).min(axis=1)
    return eq[:, -1], dd, len(ml_)

print("\n=== HONEST equity path: REAL forced sizing, 100 earnings-weeks (~2-3 yrs) ===")
print("    (each condor risks its actual maxloss; k = concurrent trades that week)")
for acct in ACCOUNTS:
    print(f"\n  Account ${acct}:")
    print(f"    {'mode':<26}{'k':>3} {'medTerm':>8} {'5th%':>7} {'medDD':>7} {'worstDD':>8} {'P(<0.7x)':>9} {'P(<0.5x)':>9}")
    # (a) trade ANY names (median bet ~10-16%/trade) at the k a small acct can field
    for k in [1, 2, 3]:
        term, dd, npool = forced_path(acct, k)
        print(f"    {'any-name (full maxloss)':<26}{k:>3} {np.median(term):7.2f}x {np.percentile(term,5):6.2f}x "
              f"{np.median(dd)*100:6.0f}% {np.percentile(dd,1)*100:7.0f}% {np.mean(term<0.7)*100:8.1f}% {np.mean(term<0.5)*100:8.1f}%")
    # (b) discipline: only trade names that fit a 5% budget (fewer, smaller bets)
    for k in [1, 2, 3]:
        term, dd, npool = forced_path(acct, k, affordable_pct=0.05)
        if term is None: continue
        print(f"    {'<=5% budget names only':<26}{k:>3} {np.median(term):7.2f}x {np.percentile(term,5):6.2f}x "
              f"{np.median(dd)*100:6.0f}% {np.percentile(dd,1)*100:7.0f}% {np.mean(term<0.7)*100:8.1f}% {np.mean(term<0.5)*100:8.1f}%")
