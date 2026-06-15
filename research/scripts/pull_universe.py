"""Pull S&P 500 constituents, then timestamped earnings dates + daily OHLC for each.
Caches everything to research/data so re-runs are cheap. Polite pacing + retries."""
import os, time, sys, json, warnings
import pandas as pd
import yfinance as yf
warnings.filterwarnings("ignore")

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(DATA, exist_ok=True)

def log(*a):
    print(*a, flush=True)

# --- 1. universe ---------------------------------------------------------
uni_path = os.path.join(DATA, "universe.csv")
if os.path.exists(uni_path):
    uni = pd.read_csv(uni_path)
    log(f"universe cached: {len(uni)} tickers")
else:
    import io, urllib.request
    url = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    raw = urllib.request.urlopen(req, timeout=30).read()
    sp = pd.read_csv(io.BytesIO(raw))
    uni = pd.DataFrame({
        "ticker": sp["Symbol"].astype(str).str.replace(".", "-", regex=False),
        "name": sp["Security"],
        "sector": sp["GICS Sector"],
        "sub_industry": sp["GICS Sub-Industry"],
    })
    uni.to_csv(uni_path, index=False)
    log(f"universe pulled: {len(uni)} tickers -> {uni_path}")

tickers = uni["ticker"].tolist()

# --- 2. per-ticker earnings dates + prices ------------------------------
earn_path = os.path.join(DATA, "earnings_dates.parquet")
px_path   = os.path.join(DATA, "prices.parquet")
done_path = os.path.join(DATA, "_done_tickers.json")

done = set()
if os.path.exists(done_path):
    done = set(json.load(open(done_path)))

earn_frames, px_frames = [], []
# load existing partial results to append
if os.path.exists(earn_path):
    earn_frames.append(pd.read_parquet(earn_path))
if os.path.exists(px_path):
    px_frames.append(pd.read_parquet(px_path))

todo = [t for t in tickers if t not in done]
log(f"{len(done)} done, {len(todo)} to fetch")

START = "2014-01-01"
flush_every = 25
processed = 0
for i, tk in enumerate(todo):
    try:
        yt = yf.Ticker(tk)
        ed = yt.get_earnings_dates(limit=60)
        if ed is not None and len(ed):
            ed = ed.reset_index()
            ed.columns = [str(c) for c in ed.columns]
            ed["ticker"] = tk
            earn_frames.append(ed)
        h = yt.history(start=START, auto_adjust=False)
        if h is not None and len(h):
            h = h.reset_index()[["Date", "Open", "High", "Low", "Close", "Volume"]]
            h["ticker"] = tk
            px_frames.append(h)
        done.add(tk)
        processed += 1
    except Exception as e:
        log(f"  ERR {tk}: {e}")
    time.sleep(0.4)  # polite pacing
    if processed and processed % flush_every == 0:
        pd.concat(earn_frames, ignore_index=True).to_parquet(earn_path, index=False)
        pd.concat(px_frames, ignore_index=True).to_parquet(px_path, index=False)
        json.dump(sorted(done), open(done_path, "w"))
        log(f"  ... {len(done)}/{len(tickers)} flushed")

# final flush
if earn_frames:
    pd.concat(earn_frames, ignore_index=True).to_parquet(earn_path, index=False)
if px_frames:
    pd.concat(px_frames, ignore_index=True).to_parquet(px_path, index=False)
json.dump(sorted(done), open(done_path, "w"))
log(f"DONE: {len(done)}/{len(tickers)} tickers. earnings->{earn_path}, prices->{px_path}")
