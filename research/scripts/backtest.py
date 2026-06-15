"""Backtest short straddle / strangle / iron condor around earnings using the
reconstructed option legs. Produces edge stats, P&L by structure, equity curve,
predictive-factor analysis, and Kelly-based sizing inputs."""
import os, warnings
import numpy as np, pandas as pd
warnings.filterwarnings("ignore")
pd.set_option("display.width", 160)

OUT = os.path.join(os.path.dirname(__file__), "..", "out")
df = pd.read_parquet(os.path.join(OUT, "options_legs.parquet"))

# ---- build structure P&L (per 1 contract = 1 share multiple; ignore x100) ----
df["earnings_date"] = pd.to_datetime(df["earnings_date"])
df["straddle_credit"] = df.e_atm_c + df.e_atm_p
df["straddle_exit"]   = df.x_atm_c + df.x_atm_p
df["straddle_pnl"]    = df.straddle_credit - df.straddle_exit

df["strangle_credit"] = df.e_sc + df.e_sp
df["strangle_exit"]   = df.x_sc + df.x_sp
df["strangle_pnl"]    = df.strangle_credit - df.strangle_exit

# iron condor: short d16 strangle, long d5 wings
df["ic_credit"] = (df.e_sc + df.e_sp) - (df.e_lc + df.e_lp)
df["ic_exit"]   = (df.x_sc + df.x_sp) - (df.x_lc + df.x_lp)
df["ic_pnl"]    = df.ic_credit - df.ic_exit
df["ic_call_w"] = df.lcK - df.scK
df["ic_put_w"]  = df.spK - df.lpK
df["ic_width"]  = df[["ic_call_w", "ic_put_w"]].max(axis=1)
df["ic_maxloss"] = (df.ic_width - df.ic_credit).clip(lower=0.01)
# Validity: drop degenerate condors where the short/long strikes collapsed (width ~ 0,
# credit ~ width) -> tiny max-loss blows up return-on-risk. Keep only sane geometry.
cw = df.ic_credit / df.ic_width
df["ic_ok"] = (df.ic_width > 0) & np.isfinite(df.ic_width) & (df.scK < df.lcK) & (df.spK > df.lpK) & cw.between(0.02, 0.70)
df.loc[~df.ic_ok, ["ic_pnl", "ic_maxloss"]] = np.nan

# normalizations
df["implied_move"] = df.straddle_credit / df.spot           # implied move to expiration
df["imp_minus_act"] = df.implied_move - df.abs_c2c          # raw edge proxy
df["straddle_ret_prem"] = df.straddle_pnl / df.straddle_credit
df["strangle_ret_prem"] = df.strangle_pnl / df.strangle_credit
df["ic_ror"] = df.ic_pnl / df.ic_maxloss                    # return on defined risk
df["straddle_ret_notional"] = df.straddle_pnl / df.spot     # P&L per $ of underlying

# --- merge each name's trailing average realized move (the scanner's benchmark) ---
pe = pd.read_parquet(os.path.join(OUT, "per_event.parquet")).sort_values(["ticker","earnings_date"])
pe["roll_avg_move"] = pe.groupby("ticker")["abs_c2c"].transform(lambda s: s.shift().expanding(min_periods=3).mean())
pe["roll_n"] = pe.groupby("ticker").cumcount()
df = df.merge(pe[["ticker","earnings_date","roll_avg_move","roll_n"]], on=["ticker","earnings_date"], how="left")
# IMEM vs the stock's OWN average move == the real edge signal from the strategy
df["imem_vs_avg"]  = df.implied_move - df.roll_avg_move          # spread (decimal)
df["imem_ratio"]   = df.implied_move / df.roll_avg_move          # how rich is implied vs typical

# basic hygiene
df = df[(df.straddle_credit > 0) & (df.strangle_credit > 0) & np.isfinite(df.ic_credit)]
df = df[df.implied_move.between(0.005, 0.60)]
print(f"USABLE TRADES: {len(df):,} across {df.ticker.nunique()} tickers, "
      f"{df.earnings_date.min().date()} -> {df.earnings_date.max().date()}\n")

def stats(pnl, label, denom=None):
    pnl = pnl.dropna()
    win = (pnl > 0).mean()
    avg = pnl.mean(); med = pnl.median()
    aw = pnl[pnl > 0].mean(); al = pnl[pnl < 0].mean()
    pf = pnl[pnl > 0].sum() / -pnl[pnl < 0].sum() if (pnl < 0).any() else np.inf
    sharpe = avg / pnl.std() if pnl.std() else np.nan
    print(f"{label:28} n={len(pnl):5} win={win*100:4.1f}%  mean={avg:+.3f} med={med:+.3f} "
          f"avgW={aw:+.3f} avgL={al:+.3f} PF={pf:4.2f} edge/sd={sharpe:+.3f}")

print("=== EDGE: implied vs actual move ===")
print(f"Implied move (straddle/spot): mean={df.implied_move.mean()*100:.2f}%  median={df.implied_move.median()*100:.2f}%")
print(f"Actual |c2c| move:            mean={df.abs_c2c.mean()*100:.2f}%  median={df.abs_c2c.median()*100:.2f}%")
print(f"P(implied > actual) = {(df.implied_move > df.abs_c2c).mean()*100:.1f}%")
print(f"Mean ratio implied/actual = {(df.implied_move/df.abs_c2c.clip(lower=1e-4)).median():.2f} (median)\n")

print("=== P&L BY STRUCTURE (per-trade, in % of premium or risk) ===")
stats(df.straddle_ret_prem, "Short straddle (%prem)")
stats(df.strangle_ret_prem, "Short strangle d16 (%prem)")
stats(df.ic_ror,            "Iron condor (%risk)")
print()
print("=== CLEANEST EXIT: T+1 only (real next-day chain; best proxy for actual strategy) ===")
d1 = df[df.exit_lag == 1]
stats(d1.straddle_ret_prem, "T+1 straddle (%prem)")
stats(d1.strangle_ret_prem, "T+1 strangle (%prem)")
stats(d1.ic_ror,            "T+1 iron condor (%risk)")
print()
print("=== P&L BY STRUCTURE (per-trade, in % of underlying notional) ===")
stats(df.straddle_ret_notional, "Short straddle ($/notional)")
stats(df.strangle_pnl/df.spot,  "Short strangle ($/notional)")
stats(df.ic_pnl/df.spot,        "Iron condor ($/notional)")

# ---- equity curve: equal $-risk per trade, aggregated by day ----
def equity(col_pnl, col_norm, name):
    s = (df[col_pnl] / df[col_norm]).dropna()
    daily = df.assign(r=s).groupby(df.earnings_date.dt.to_period("Q"))["r"].mean()
    cum = daily.cumsum()
    print(f"\n{name}: per-trade mean={s.mean()*100:+.2f}% of unit-risk | "
          f"quarterly mean={daily.mean()*100:+.2f}% | worst Q={daily.min()*100:+.2f}% | "
          f"best Q={daily.max()*100:+.2f}% | %Q up={ (daily>0).mean()*100:.0f}%")
    return daily

q_str = equity("straddle_pnl", "straddle_credit", "Straddle (%prem, eq-wt/Q)")
q_ic  = equity("ic_pnl", "ic_maxloss", "Iron condor (%risk, eq-wt/Q)")

# ---- predictive factors (straddle %prem as target) ----
print("\n=== PREDICTIVE FACTORS (straddle return on premium) ===")
df["edge_bucket"] = pd.qcut(df.imp_minus_act, 5, labels=["Q1 low","Q2","Q3","Q4","Q5 high"])
print("By implied-minus-actual-move quintile:")
print((df.groupby("edge_bucket")["straddle_ret_prem"].agg(["mean","median","count"]) ).round(3).to_string())

sig = df.dropna(subset=["imem_vs_avg"])
if len(sig) > 50:
    sig = sig.copy(); sig["imem_bucket"] = pd.qcut(sig.imem_vs_avg, 5, labels=["Q1 cheap","Q2","Q3","Q4","Q5 rich"])
    print("\nBy IMEM-vs-own-average-move quintile (the strategy's real signal):")
    print((sig.groupby("imem_bucket")["straddle_ret_prem"].agg(["mean","median","count"])).round(3).to_string())
    print(f"  >> trade only when implied > 1.0x avg move: mean={sig[sig.imem_ratio>1].straddle_ret_prem.mean():.3f} "
          f"(n={ (sig.imem_ratio>1).sum() }) vs implied<avg: mean={sig[sig.imem_ratio<1].straddle_ret_prem.mean():.3f} (n={(sig.imem_ratio<1).sum()})")

df["iv_bucket"] = pd.qcut(df.atm_iv, 5, labels=["IV1 low","IV2","IV3","IV4","IV5 high"])
print("\nBy ATM IV quintile:")
print((df.groupby("iv_bucket")["straddle_ret_prem"].agg(["mean","count"])).round(3).to_string())

print("\nBy sector (mean straddle %prem):")
print((df.groupby("sector")["straddle_ret_prem"].agg(["mean","count"]).sort_values("mean", ascending=False)).round(3).to_string())

print("\nBy timing:")
print((df.groupby("timing")["straddle_ret_prem"].agg(["mean","count"])).round(3).to_string())

print("\n=== ROBUSTNESS BY YEAR (straddle %prem & iron condor %risk) ===")
df["year"] = df.earnings_date.dt.year
yr = df.groupby("year").agg(n=("straddle_ret_prem","size"),
                            straddle_mean=("straddle_ret_prem","mean"),
                            straddle_win=("straddle_ret_prem", lambda s:(s>0).mean()),
                            ic_mean=("ic_ror","mean"))
print((yr.assign(straddle_mean=yr.straddle_mean.round(3), straddle_win=(yr.straddle_win*100).round(0),
                 ic_mean=yr.ic_mean.round(3))).to_string())

print("\n=== EXIT-LAG SENSITIVITY (real exit day used) ===")
print((df.groupby("exit_lag")["straddle_ret_prem"].agg(["mean","count"])).round(3).to_string())

# correlation of candidate signals with outcome
print("\nSignal correlations with straddle %prem return:")
for s in ["imp_minus_act","imem_vs_avg","imem_ratio","implied_move","atm_iv","dte","spot","roll_avg_move"]:
    print(f"  {s:16} corr={df[[s,'straddle_ret_prem']].corr().iloc[0,1]:+.3f}")

# ---- Kelly inputs from straddle and IC ----
print("\n=== POSITION SIZING INPUTS ===")
for name, ror in [("Iron condor (ret/risk)", df.ic_ror.dropna()),
                  ("Straddle (ret/premium)", df.straddle_ret_prem.dropna())]:
    mu, sd = ror.mean(), ror.std()
    # full-Kelly for continuous returns ~ mu/var (in units of the bet's unit-risk)
    kelly = mu / (sd**2) if sd else np.nan
    p = (ror>0).mean(); b = ror[ror>0].mean()/-ror[ror<0].mean() if (ror<0).any() else np.inf
    kelly_bin = (p - (1-p)/b) if np.isfinite(b) else np.nan
    print(f"{name:24} mean={mu:+.3f} sd={sd:.3f} | cont-Kelly={kelly:.2f}x unit-risk | "
          f"binomial-Kelly f*={kelly_bin:+.3f} | p(win)={p*100:.1f}% payoff b={b:.2f}")

df.to_parquet(os.path.join(OUT, "trades_enriched.parquet"), index=False)
q_str.to_csv(os.path.join(OUT, "equity_straddle_Q.csv"))
q_ic.to_csv(os.path.join(OUT, "equity_ic_Q.csv"))
print("\nsaved trades_enriched.parquet + quarterly equity csvs")
