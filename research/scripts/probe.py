"""Probe what yfinance actually exposes for earnings-strategy research."""
import yfinance as yf
import pandas as pd
import warnings
warnings.filterwarnings("ignore")

t = yf.Ticker("AAPL")

print("=== get_earnings_dates (history of earnings + EPS surprise) ===")
try:
    ed = t.get_earnings_dates(limit=40)
    print(type(ed))
    print(ed.head(12))
    print("...")
    print("rows:", len(ed), "| span:", ed.index.min(), "->", ed.index.max())
except Exception as e:
    print("ERR", e)

print("\n=== earnings_dates attribute columns ===")
try:
    print(list(ed.columns))
except Exception as e:
    print("ERR", e)

print("\n=== option expirations (current only) ===")
try:
    print(t.options[:6], "...", "n=", len(t.options))
    oc = t.option_chain(t.options[0])
    print("calls cols:", list(oc.calls.columns))
    print("sample call IV:", oc.calls[["strike","lastPrice","impliedVolatility","volume","openInterest"]].head(3).to_dict("records"))
except Exception as e:
    print("ERR", e)

print("\n=== history sample ===")
h = t.history(period="5d", auto_adjust=False)
print(h[["Open","Close"]].tail(3))
