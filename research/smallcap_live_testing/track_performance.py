"""Performance tracker for the wheel paper test.

Two inputs you maintain (templates: *_example.csv):
  equity_log.csv  — periodic snapshots of the thinkorswim paperMoney account
                    value (the source of truth). cols: date, account_value, cash
  trades.csv      — your actual fills, for attribution. cols: date, ticker,
                    action, qty, plan_price, fill_price, status  (status:
                    open|expired|assigned|called_away|closed|bail)

Outputs a dashboard: account equity curve -> total return / CAGR / max-DD vs
SPY buy-and-hold over the same window; plus fill-slippage, premium capture,
win rate and assignment rate vs the backtest expectation. Everything degrades
gracefully — run it with only equity_log.csv for the headline numbers.

Backtest expectation to beat (filtered prem>=0.8 hold-and-CC, MC medians):
  ~+16.7% CAGR, ~8% max-DD, beat SPY; entry ann-yield >= 0.80; assignment ~50%.
"""
import os
import sys
from datetime import date

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
EQ = os.path.join(HERE, "equity_log.csv")
TR = os.path.join(HERE, "trades.csv")


def perf_from_curve(dates, values):
    v = np.asarray(values, float)
    days = (dates.iloc[-1] - dates.iloc[0]).days or 1
    tot = v[-1] / v[0] - 1
    cagr = (v[-1] / v[0]) ** (365.25 / days) - 1
    dd = float((1 - v / np.maximum.accumulate(v)).max())
    return dict(start=v[0], end=v[-1], total=tot, cagr=cagr, maxdd=dd, days=days)


def spy_bench(start, end):
    try:
        import yfinance as yf
        s = yf.Ticker("SPY").history(start=str(start), end=str(end),
                                     auto_adjust=True)["Close"]
        s.index = pd.to_datetime(s.index).tz_localize(None)
        if len(s) < 2:
            return None
        d = (s.index[-1] - s.index[0]).days or 1
        return dict(total=s.iloc[-1] / s.iloc[0] - 1,
                    cagr=(s.iloc[-1] / s.iloc[0]) ** (365.25 / d) - 1,
                    maxdd=float((1 - s / s.cummax()).max()))
    except Exception as e:
        print(f"  (SPY fetch failed: {e})")
        return None


def account_report():
    if not os.path.exists(EQ):
        print("No equity_log.csv yet — copy equity_log_example.csv and log your "
              "thinkorswim account value periodically.\n")
        return
    e = pd.read_csv(EQ).dropna(subset=["account_value"])
    e["date"] = pd.to_datetime(e["date"])
    e = e.sort_values("date")
    if len(e) < 2:
        print(f"Account: ${e.account_value.iloc[-1]:,.0f} "
              f"(need >=2 snapshots for return/DD).\n")
        return
    p = perf_from_curve(e["date"], e["account_value"])
    print("=== ACCOUNT PERFORMANCE (from thinkorswim snapshots) ===")
    print(f"  {e.date.iloc[0].date()} -> {e.date.iloc[-1].date()}  ({p['days']}d)")
    print(f"  ${p['start']:,.0f} -> ${p['end']:,.0f}   "
          f"P&L ${p['end']-p['start']:+,.0f} ({p['total']:+.1%})")
    print(f"  CAGR (annualized): {p['cagr']:+.1%}     max drawdown: {p['maxdd']:.1%}")
    spy = spy_bench(e.date.iloc[0].date(), e.date.iloc[-1].date() + pd.Timedelta(days=1))
    if spy:
        print(f"\n  vs SPY buy&hold same window:")
        print(f"    strategy  return {p['total']:+.1%}  CAGR {p['cagr']:+.1%}  DD {p['maxdd']:.1%}")
        print(f"    SPY       return {spy['total']:+.1%}  CAGR {spy['cagr']:+.1%}  DD {spy['maxdd']:.1%}")
        print(f"    excess return: {p['total']-spy['total']:+.1%}   "
              f"DD {'lower' if p['maxdd']<spy['maxdd'] else 'higher'} than SPY")
    print(f"\n  backtest expectation: ~+16.7% CAGR, ~8% max-DD (small live n — "
          f"expect wide error bars early)\n")


def attribution_report():
    if not os.path.exists(TR):
        print("No trades.csv yet — copy trades_example.csv and log fills to get "
              "slippage / win-rate / assignment attribution.")
        return
    t = pd.read_csv(TR)
    opens = t[t.action.isin(["SELL_PUT", "SELL_CALL"])].copy()
    print("=== STRATEGY ATTRIBUTION (from fills) ===")
    if len(opens) and opens[["plan_price", "fill_price"]].notna().all(axis=1).any():
        o = opens.dropna(subset=["plan_price", "fill_price"])
        o = o[o.plan_price > 0]
        slip = (o.fill_price - o.plan_price) / o.plan_price
        print(f"  fill slippage vs plan mid: median {slip.median():+.1%}, "
              f"mean {slip.mean():+.1%}  (n={len(o)}; negative = worse fills — "
              f"the #1 live risk)")
    puts = t[t.action == "SELL_PUT"]
    if len(puts):
        closed = t[t.status.isin(["expired", "assigned", "called_away", "closed", "bail"])]
        assigned = t[t.status == "assigned"]
        print(f"  puts sold: {len(puts)}   assignment rate: "
              f"{len(assigned)/max(len(puts),1):.0%} (backtest ~50%)")
        wins = t[t.status.isin(["expired", "called_away"])]
        if len(closed):
            print(f"  closed legs: {len(closed)}   "
                  f"favorable (expired OTM / called away): "
                  f"{len(wins)/max(len(closed),1):.0%}")
    print(f"  open positions: {(t.status=='open').sum()}")


if __name__ == "__main__":
    print(f"\nWHEEL PAPER-TEST PERFORMANCE  —  {date.today()}\n")
    account_report()
    attribution_report()
