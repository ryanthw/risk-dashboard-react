"""Visualize the earnings short-vol backtest — comparing THREE structures:
naked short straddle, iron butterfly (ATM/Δ5), iron condor (Δ16/Δ5). Reads
trades_enriched.parquet (+ per_event for the broad move distribution).
Saves PNGs to research/out/charts."""
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

# the three structures, as return on capital-at-risk (naked straddle on 18% margin
# proxy; butterfly/condor on defined max-loss) — a common, comparable footing.
STRUCTS = [("straddle_ror", RED,   "Naked straddle"),
           ("ibf_ror",      STEEL, "Iron butterfly"),
           ("ic_ror",       NAVY,  "Iron condor")]

def save(fig, name):
    fig.tight_layout(); p=os.path.join(CH,name); fig.savefig(p,dpi=130,bbox_inches="tight"); plt.close(fig); print("saved",p)

# 1) Implied vs actual move distribution -------------------------------------
fig,ax=plt.subplots(figsize=(8,5))
ax.hist(df.abs_c2c*100, bins=np.arange(0,30,0.7), alpha=0.78, color=STEEL, label="Actual |move| (realized)")
ax.hist(df.implied_move*100, bins=np.arange(0,30,0.7), alpha=0.55, color=NAVY, label="Implied move (straddle/spot)")
ax.axvline(df.abs_c2c.median()*100, color=STEEL, ls="--", lw=2)
ax.axvline(df.implied_move.median()*100, color=NAVY, ls="--", lw=2)
ax.set_xlim(0,25); ax.set_xlabel("% move"); ax.set_ylabel("events")
ax.set_title(f"Implied vs Actual earnings move  (n={len(df):,})\nmedian implied {df.implied_move.median()*100:.1f}%  >  median actual {df.abs_c2c.median()*100:.1f}%  ·  implied>actual {(df.implied_move>df.abs_c2c).mean()*100:.0f}%")
ax.legend(); save(fig,"01_implied_vs_actual_dist.png")

# 2) Scatter implied vs actual ----------------------------------------------
fig,ax=plt.subplots(figsize=(7,7))
win=df.straddle_pnl>0
ax.scatter(df.implied_move[win]*100, df.abs_c2c[win]*100, s=5, c=BLUE, alpha=0.25, label="straddle win")
ax.scatter(df.implied_move[~win]*100, df.abs_c2c[~win]*100, s=7, c=RED, alpha=0.4, label="straddle loss")
m=max(df.implied_move.quantile(.99),df.abs_c2c.quantile(.99))*100
ax.plot([0,m],[0,m],color=NAVY,lw=1.5,ls="--",label="actual = implied")
ax.set_xlim(0,m); ax.set_ylim(0,m); ax.set_xlabel("implied move %"); ax.set_ylabel("actual |move| %")
ax.set_title("Edge: points below the line = seller wins\n(implied overstated the move)")
ax.legend(); save(fig,"02_implied_vs_actual_scatter.png")

# 3) THREE-WAY equity curves (cumulative quarterly-mean return on risk) -------
df["Q"]=df.earnings_date.dt.to_period("Q").dt.to_timestamp()
fig,ax=plt.subplots(figsize=(9.5,5.5))
for col,color,label in STRUCTS:
    q=df.groupby("Q")[col].mean().dropna()
    x=pd.DatetimeIndex([q.index[0]-pd.Timedelta(days=80)]).append(q.index)  # anchor at 0
    y=np.concatenate([[0.0], (q.cumsum()*100).values])
    ax.plot(x, y, color=color, lw=2, marker="o", ms=3, label=label)
ax.axhline(0,color=GREY,lw=1)
ax.set_ylabel("cumulative Σ quarterly-mean return on risk (%)")
ax.set_title("Strategy comparison — cumulative equal-weight P&L on capital-at-risk\nnaked straddle (18% margin) bleeds out; defined-risk butterfly & condor compound up")
ax.legend(loc="upper left"); save(fig,"03_equity_curves_3way.png")

# 4) THREE-WAY P&L distribution (return on risk) -----------------------------
fig,ax=plt.subplots(figsize=(8.5,5))
bins=np.arange(-2.0,1.05,0.08)
for col,color,label in STRUCTS:
    s=df[col].dropna().clip(-2,1)
    ax.hist(s, bins=bins, histtype="step", lw=2, color=color, label=f"{label} (mean {s.mean()*100:+.0f}%)", density=True)
ax.axvline(0,color=GREY,lw=1); ax.axvline(-1,color=GREY,ls=":",lw=1)
ax.annotate("defined-risk floor = −1×", xy=(-1,0.2), xytext=(-1.9,1.1), fontsize=8, color=GREY)
ax.set_xlabel("per-trade return on capital-at-risk"); ax.set_ylabel("density")
ax.set_title("P&L distributions — naked straddle's left tail runs past −1×;\nbutterfly & condor are bounded at the defined max-loss")
ax.legend(); save(fig,"04_pnl_distribution_3way.png")

# 5) Edge factor: straddle P&L by implied-minus-actual quintile --------------
fig,ax=plt.subplots(figsize=(8,5))
g=df.groupby("edge_bucket")["straddle_ret_prem"].mean()*100
ax.bar(range(len(g)), g.values, color=[RED if v<0 else BLUE for v in g.values])
ax.set_xticks(range(len(g))); ax.set_xticklabels(g.index)
ax.set_ylabel("mean straddle P&L (% premium)")
ax.set_title("Edge factor: straddle return by (implied − actual) move quintile\n(illustrative — uses realized move, so not tradeable ex-ante)")
for i,v in enumerate(g.values): ax.text(i, v+(1 if v>=0 else -3), f"{v:.0f}%", ha="center", fontsize=9)
save(fig,"05_edge_by_quintile.png")

# 6) THREE-WAY robustness by year (mean return on risk) ----------------------
df["year"]=df.earnings_date.dt.year
yrs=sorted(df.year.unique()); x=np.arange(len(yrs)); w=0.27
fig,ax=plt.subplots(figsize=(9.5,5))
for i,(col,color,label) in enumerate(STRUCTS):
    vals=[df[df.year==y][col].mean()*100 for y in yrs]
    ax.bar(x+(i-1)*w, vals, w, color=color, label=label)
ax.axhline(0,color=GREY,lw=1); ax.set_xticks(x); ax.set_xticklabels(yrs)
ax.set_ylabel("mean per-trade return on risk (%)")
ax.set_title("Robustness by year — naked straddle loses in 2022–24;\ndefined-risk butterfly & condor positive every year")
ax.legend(); save(fig,"06_by_year_3way.png")

# 7) Structure summary — win% / profit factor / edge-σ -----------------------
def summ(col):
    s=df[col].dropna(); pf=s[s>0].sum()/-s[s<0].sum() if (s<0).any() else np.nan
    return (s>0).mean()*100, pf, s.mean()/s.std()
labels=[l for _,_,l in STRUCTS]; cols=[c for c,_,_ in STRUCTS]; colors=[c for _,c,_ in STRUCTS]
W,P,E=zip(*[summ(c) for c in cols])
fig,axs=plt.subplots(1,3,figsize=(11,4))
for ax,vals,title,fmt in [(axs[0],W,"Win rate (%)","%.0f"),(axs[1],P,"Profit factor","%.2f"),(axs[2],E,"Edge / σ (per trade)","%.2f")]:
    ax.bar(labels,vals,color=colors)
    for i,v in enumerate(vals): ax.text(i,v,(fmt%v),ha="center",va="bottom",fontsize=9)
    ax.set_title(title); ax.tick_params(axis="x",labelrotation=15)
    if title.startswith("Profit"): ax.axhline(1,color=GREY,ls=":",lw=1)
    if title.startswith("Edge"): ax.axhline(0,color=GREY,lw=1)
fig.suptitle("Structure scorecard (full real sample, return on capital-at-risk)",fontweight="bold")
save(fig,"07_structure_scorecard.png")

# 8) Broad realized move distribution (context) ------------------------------
fig,ax=plt.subplots(figsize=(8,5))
ax.hist(ev.abs_c2c.dropna()*100, bins=np.arange(0,30,0.5), color=NAVY, alpha=0.8)
ax.set_xlim(0,25); ax.set_xlabel("|close-to-close earnings move| %"); ax.set_ylabel("events")
ax.set_title(f"Realized earnings moves — expanded universe  (n={ev.abs_c2c.notna().sum():,})\nmedian {ev.abs_c2c.median()*100:.1f}%  mean {ev.abs_c2c.mean()*100:.1f}%  p95 {ev.abs_c2c.quantile(.95)*100:.1f}%")
save(fig,"08_realized_move_dist.png")
print("ALL CHARTS DONE")
