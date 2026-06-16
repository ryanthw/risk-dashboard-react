"""Pull daily prices for a liquid ETF universe (for the dual/TS-momentum study).
yfinance, max history, appended to a dedicated parquet (keeps stock panel clean)."""
import os, time, warnings
import pandas as pd, yfinance as yf
warnings.filterwarnings("ignore")
DATA = os.path.join(os.path.dirname(__file__), "..", "data")

UNIVERSE = {
    "equity": ["SPY","QQQ","IWM","MDY","EFA","EEM","VGK","EWJ"],
    "bond":   ["TLT","IEF","LQD","HYG","TIP","SHY","AGG","BND"],
    "real":   ["GLD","SLV","DBC","GSG","VNQ"],
    "sector": ["XLK","XLF","XLE","XLV","XLI","XLY","XLP","XLU","XLB","XLRE","XLC"],
    "cash":   ["BIL"],
}
tickers = sorted({t for v in UNIVERSE.values() for t in v})
print(f"pulling {len(tickers)} ETFs", flush=True)
frames = []
for t in tickers:
    try:
        df = yf.download(t, period="max", interval="1d", auto_adjust=True, progress=False)
        if df is None or df.empty:
            print("  EMPTY", t, flush=True); continue
        df = df.reset_index()[["Date","Open","High","Low","Close","Volume"]]
        df["ticker"] = t
        frames.append(df)
        print(f"  {t}: {len(df)} rows {df.Date.min().date()}..{df.Date.max().date()}", flush=True)
    except Exception as e:
        print("  ERR", t, str(e)[:60], flush=True)
    time.sleep(0.4)
out = pd.concat(frames, ignore_index=True)
out.to_parquet(os.path.join(DATA, "etf_prices.parquet"), index=False)
grp = {k: [t for t in v] for k, v in UNIVERSE.items()}
import json; json.dump(grp, open(os.path.join(DATA, "etf_universe.json"), "w"), indent=2)
print(f"DONE_ETF: {len(out)} rows -> etf_prices.parquet", flush=True)
