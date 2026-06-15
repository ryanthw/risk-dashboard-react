"""Visualize earnings short-vol backtest results. Reads trades_enriched.parquet
(+ per_event for the broad move distribution). Saves PNGs to research/out/charts."""
import os, warnings
import numpy as np, pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
warnings.filterwarnings("ignore")

OUT = os.path.join(os.path.dirname(__file__), "..", "out")
CH  = os.path.join(OUT, "charts"); os.makedirs(CH, exist_ok=True)

# industrial blue / steel / white palette (matches dashboard theme)
NAVY="#1f3a5f"; BLUE="#2e6da4"; STEEL="#5b8db8"; LT="#a9c4dd"; GREY="#6b7785"; RED="#b5482e"; BG="#f4f6f8"
plt.rcParams.update({"figure.facecolor":"white","axes.facecolor":BG,"axes.edgecolor":GREY,
                     "axes.grid":True,"grid.color":"#dde3e9","font.size":10,"axes.titleweight":"bold"})

df = pd.read_parquet(os.path.join(OUT, "trades_enriched.parquet"))
df["earnings_date"] = pd.to_datetime(df["earnings_date"])
ev = pd.read_parquet(os.path.join(OUT, "per_event.parquet"))

def save(fig, name):
    fig.tight_layout(); p=os.path.join(CH,name); fig.savefig(p,dpi=130,bbox_inches="tight"); plt.close(fig); print("saved",p)

# 1) Implied vs actual move distribution -------------------------------------
fig,ax=plt.subplots(figsize=(8,5))
ax.hist(df.abs_c2c*100, bins=np.arange(0,30,0.7), alpha=0.78, color=STEEL, label="Actual |move| (realized)")
ax.hist(df.implied_move*100, bins=np.arange(0,30,0.7), alpha=0.55, color=NAVY, label="Implied move (straddle/spot)")
ax.axvline(df.abs_c2c.median()*100, color=STEEL, ls="--", lw=2)
ax.axvline(df.implied_move.median()*100, color=NAVY, ls="--", lw=2)
ax.set_xlim(0,25); ax.set_xlabel("% move"); ax.set_ylabel("events")
ax.set_title(f"Implied vs Actual earnings move  (n={len(df):,})\nmedian implied {df.implied_move.median()*100:.1f}%  >  median actual {df.abs_c2c.median()*100:.1f}%")
ax.legend(); save(fig,"01_implied_vs_actual_dist.png")

# 2) Scatter implied vs actual, colored by straddle win/loss ------------------
fig,ax=plt.subplots(figsize=(7,7))
win=df.straddle_pnl>0
ax.scatter(df.implied_move[win]*100, df.abs_c2c[win]*100, s=7, c=BLUE, alpha=0.35, label="straddle win")
ax.scatter(df.implied_move[~win]*100, df.abs_c2c[~win]*100, s=9, c=RED, alpha=0.5, label="straddle loss")
m=max(df.implied_move.quantile(.99),df.abs_c2c.quantile(.99))*100
ax.plot([0,m],[0,m],color=NAVY,lw=1.5,ls="--",label="actual = implied")
ax.set_xlim(0,m); ax.set_ylim(0,m); ax.set_xlabel("implied move %"); ax.set_ylabel("actual |move| %")
ax.set_title("Edge: points below the line = seller wins\n(implied overstated the move)")
ax.legend(); save(fig,"02_implied_vs_actual_scatter.png")

# 3) Equity curves (equal-weight per event, chronological) -------------------
d=df.sort_values("earnings_date")
fig,(a1,a2)=plt.subplots(2,1,figsize=(9,8),sharex=True)
a1.plot(d.earnings_date, (d.straddle_ret_prem.fillna(0)).cumsum(), color=NAVY, lw=1.6)
a1.set_ylabel("cum. Σ return /premium"); a1.set_title("Short ATM straddle — cumulative equal-weight P&L (units of premium)")
a2.plot(d.earnings_date, (d.ic_ror.fillna(0)).cumsum(), color=BLUE, lw=1.6)
a2.set_ylabel("cum. Σ return /risk"); a2.set_title("Iron condor (Δ16/Δ5) — cumulative equal-weight P&L (units of max risk)")
save(fig,"03_equity_curves.png")

# 4) P&L distribution (the short-vol left tail) ------------------------------
fig,ax=plt.subplots(figsize=(8,5))
r=df.straddle_ret_prem.dropna()*100
ax.hist(r, bins=np.arange(-400,120,15), color=STEEL, alpha=0.85)
ax.axvline(r.mean(), color=NAVY, lw=2, label=f"mean {r.mean():.0f}%")
ax.axvline(0, color=GREY, lw=1)
ax.set_xlabel("straddle P&L (% of premium)"); ax.set_ylabel("events")
ax.set_title(f"Short straddle P&L distribution — small wins, fat left tail\nwin rate {100*(r>0).mean():.0f}%   mean {r.mean():.0f}%   worst {r.min():.0f}%")
ax.legend(); save(fig,"04_pnl_distribution.png")

# 5) Edge factor: P&L by implied-minus-actual quintile -----------------------
fig,ax=plt.subplots(figsize=(8,5))
g=df.groupby("edge_bucket")["straddle_ret_prem"].mean()*100
ax.bar(range(len(g)), g.values, color=[RED if v<0 else BLUE for v in g.values])
ax.set_xticks(range(len(g))); ax.set_xticklabels(g.index, rotation=0)
ax.set_ylabel("mean straddle P&L (% premium)")
ax.set_title("Predictive edge: straddle return by (implied − actual) move quintile")
for i,v in enumerate(g.values): ax.text(i, v+(1 if v>=0 else -3), f"{v:.0f}%", ha="center", fontsize=9)
save(fig,"05_edge_by_quintile.png")

# 6) Robustness by year ------------------------------------------------------
fig,ax=plt.subplots(figsize=(9,5))
yr=df.assign(year=df.earnings_date.dt.year).groupby("year")["straddle_ret_prem"]
mean=yr.mean()*100; win=yr.apply(lambda s:(s>0).mean())*100; n=yr.size()
ax.bar(mean.index, mean.values, color=[RED if v<0 else STEEL for v in mean.values], label="mean P&L %prem")
ax2=ax.twinx(); ax2.plot(win.index, win.values, color=NAVY, marker="o", lw=2, label="win rate %")
ax2.set_ylim(0,100); ax.set_ylabel("mean P&L (% premium)"); ax2.set_ylabel("win rate %")
ax.set_title("Robustness by year — mean straddle P&L (bars) & win rate (line)")
for x,v in zip(n.index,n.values): ax.text(x, ax.get_ylim()[0]*0.9, f"n={v}", ha="center", fontsize=7, color=GREY)
ax.legend(loc="upper left"); ax2.legend(loc="upper right"); save(fig,"06_by_year.png")

# 7) Broad realized move distribution (full 10yr S&P, context) ---------------
fig,ax=plt.subplots(figsize=(8,5))
ax.hist(ev.abs_c2c.dropna()*100, bins=np.arange(0,30,0.5), color=NAVY, alpha=0.8)
ax.set_xlim(0,25); ax.set_xlabel("|close-to-close earnings move| %"); ax.set_ylabel("events")
ax.set_title(f"Realized S&P 500 earnings moves, 2014-2025  (n={ev.abs_c2c.notna().sum():,})\nmedian {ev.abs_c2c.median()*100:.1f}%  mean {ev.abs_c2c.mean()*100:.1f}%  p95 {ev.abs_c2c.quantile(.95)*100:.1f}%")
save(fig,"07_realized_move_dist.png")
print("ALL CHARTS DONE")
