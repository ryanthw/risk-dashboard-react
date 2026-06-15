"""Position-sizing study for the earnings short-vol strategy.
Uses the REAL per-trade return distribution to derive Kelly fractions and to
Monte-Carlo portfolio equity paths (terminal growth vs max drawdown vs ruin) at
a grid of per-trade risk fractions. Iron condor (defined risk) is the primary
sizing vehicle; short straddle sized on a margin proxy for comparison."""
import os, warnings
import numpy as np, pandas as pd
warnings.filterwarnings("ignore")
rng = np.random.default_rng(7)
OUT = os.path.join(os.path.dirname(__file__), "..", "out")
df = pd.read_parquet(os.path.join(OUT, "trades_enriched.parquet"))

# ---- per-trade return in units of "capital at risk" ----
# iron condor: risk = max loss (defined). clip to [-1, +cap] (can't lose > maxloss).
ic = (df.ic_pnl / df.ic_maxloss).dropna().clip(-1.0, 1.0).values
# short straddle: assume broker margin ~= 18% of underlying notional per straddle.
MARGIN = 0.18
strad = (df.straddle_pnl / (MARGIN * df.spot)).dropna().clip(-6.0, 1.0).values

def kelly_continuous(r):
    mu, var = r.mean(), r.var()
    return mu / var if var > 0 else np.nan

def simulate(r, f, n_trades=400, n_paths=4000):
    """Compound n_trades random trades (bootstrap), risking fraction f of equity each.
    Returns arrays of terminal multiple and max fractional drawdown."""
    idx = rng.integers(0, len(r), size=(n_paths, n_trades))
    steps = 1.0 + f * r[idx]
    steps = np.clip(steps, 1e-6, None)            # equity can't go negative
    logpath = np.cumsum(np.log(steps), axis=1)
    eq = np.exp(logpath)
    term = eq[:, -1]
    running_max = np.maximum.accumulate(eq, axis=1)
    dd = (eq / running_max - 1.0).min(axis=1)     # most negative
    return term, dd

print(f"trades: iron condor n={len(ic)}, straddle n={len(strad)}\n")
for name, r in [("IRON CONDOR (risk=max loss)", ic), ("SHORT STRADDLE (risk=18% notional)", strad)]:
    p = (r > 0).mean(); mu = r.mean()
    b = r[r > 0].mean() / -r[r < 0].mean() if (r < 0).any() else np.inf
    kc = kelly_continuous(r)
    print(f"=== {name} ===")
    print(f"  per-trade: mean={mu:+.3f} sd={r.std():.3f} win={p*100:.1f}% payoff b={b:.2f}  "
          f"min={r.min():+.2f} p1={np.percentile(r,1):+.2f}")
    print(f"  continuous-Kelly f* = {kc:.2f}  (full Kelly risks {kc*100:.0f}% of equity per trade -- too hot)")
    print(f"  {'f/trade':>8} {'medianCAGRx':>12} {'5th%term':>9} {'medMaxDD':>9} {'worstMaxDD':>11} {'P(lose>50%)':>12}")
    for f in [0.005, 0.01, 0.02, 0.03, 0.05, 0.08]:
        term, dd = simulate(r, f)
        # express terminal as annualized-ish: assume 400 trades ~= 2 yrs of active trading
        cagr = term ** (1/2.0)  # 2-year horizon -> annual multiple
        print(f"  {f*100:6.1f}% {np.median(cagr):11.2f}x {np.percentile(term,5):8.2f}x "
              f"{np.median(dd)*100:8.0f}% {np.percentile(dd,1)*100:10.0f}% {np.mean(term<0.5)*100:11.1f}%")
    print()

# ---- diversification benefit: portfolio of k concurrent uncorrelated trades ----
print("=== DIVERSIFICATION: std of an equal-weight basket of k independent trades (IC) ===")
for k in [1, 3, 5, 10, 20, 40]:
    sims = r = ic[rng.integers(0, len(ic), size=(20000, k))].mean(axis=1)
    print(f"  k={k:2d}: basket mean={sims.mean():+.3f}  sd={sims.std():.3f}  "
          f"5th%={np.percentile(sims,5):+.3f}  P(basket<0)={np.mean(sims<0)*100:.1f}%")
print("\n(uncorrelated earnings events let many small bets smooth the fat single-trade tail)")
