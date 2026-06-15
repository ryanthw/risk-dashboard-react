"""Pull yfinance earnings dates + daily OHLC for an arbitrary ticker-list file,
appending to the SAME shared caches used by the original S&P pull (resumable;
already-done tickers are skipped). Usage: pull_extra.py <tickers_file>"""
import os, sys, time, json, warnings
import pandas as pd, yfinance as yf
warnings.filterwarnings("ignore")

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
earn_path = os.path.join(DATA, "earnings_dates.parquet")
px_path   = os.path.join(DATA, "prices.parquet")
done_path = os.path.join(DATA, "_done_tickers.json")
START = "2014-01-01"

tickers_file = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DATA, "pilot_tickers.txt")
want = [l.strip() for l in open(tickers_file) if l.strip()]
done = set(json.load(open(done_path))) if os.path.exists(done_path) else set()
todo = [t for t in want if t not in done]
print(f"{len(want)} requested, {len(todo)} to fetch (rest already cached)", flush=True)

earn_frames = [pd.read_parquet(earn_path)] if os.path.exists(earn_path) else []
px_frames   = [pd.read_parquet(px_path)] if os.path.exists(px_path) else []

processed = 0
for tk in todo:
    try:
        yt = yf.Ticker(tk)
        ed = yt.get_earnings_dates(limit=60)
        if ed is not None and len(ed):
            ed = ed.reset_index(); ed.columns = [str(c) for c in ed.columns]; ed["ticker"] = tk
            earn_frames.append(ed)
        h = yt.history(start=START, auto_adjust=False)
        if h is not None and len(h):
            h = h.reset_index()[["Date", "Open", "High", "Low", "Close", "Volume"]]; h["ticker"] = tk
            px_frames.append(h)
        done.add(tk); processed += 1
    except Exception as e:
        print(f"  ERR {tk}: {e}", flush=True)
    time.sleep(0.4)
    if processed and processed % 25 == 0:
        pd.concat(earn_frames, ignore_index=True).to_parquet(earn_path, index=False)
        pd.concat(px_frames, ignore_index=True).to_parquet(px_path, index=False)
        json.dump(sorted(done), open(done_path, "w"))
        print(f"  ... {processed}/{len(todo)} fetched", flush=True)

if earn_frames: pd.concat(earn_frames, ignore_index=True).to_parquet(earn_path, index=False)
if px_frames: pd.concat(px_frames, ignore_index=True).to_parquet(px_path, index=False)
json.dump(sorted(done), open(done_path, "w"))
print(f"DONE_EXTRA: fetched {processed}, total done {len(done)}", flush=True)
