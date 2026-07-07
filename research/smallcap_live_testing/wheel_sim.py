"""Self-contained mark-to-market forward simulator for the wheel.

Fully automatable paper test: pulls live data (Public), FILLS at the option's
mark (mid) subject to a volume liquidity gate (>= MIN_VOL contracts), and runs
the whole wheel lifecycle against an internally-managed portfolio — no broker,
no manual clicking. Designed to run on a schedule (GitHub Actions), commit its
state, and email the run as a report.

Honest tradeoff (accepted by design): mark fills skip real execution/slippage,
so results are optimistic vs a true fill. The volume gate + conservative mid
(no crossing the spread in your favour) partly offset it. Judge it as an upper
bound on live performance; the manual paper test measures the slippage gap.

State: state/portfolio.json (positions + cash), committed each run. Also appends
equity_log.csv / trades.csv so track_performance.py works unchanged.

Cash accounting (cash-secured): sell put -> cash += credit; assigned -> cash -=
strike*100 (buy shares); sell CC -> cash += credit; called away -> cash +=
callstrike*100; bail -> cash += spot*100. Net-liq equity = cash + shares*spot -
short-option marks. Deployable = cash - open-put collateral.
"""
import json
import os
import sys
from datetime import date, datetime, timezone

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from wheel_live import (CFG, Config, token, hdr, equity_stats,  # noqa: E402
                        option_chain, target_expiration, osi, pick_contract,
                        get_mark, entry_candidates, send_email)

STATE = os.path.join(HERE, "state", "portfolio.json")
EQ_LOG = os.path.join(HERE, "equity_log.csv")
TRADES = os.path.join(HERE, "trades.csv")
MIN_VOL = 10          # "fillable" if day volume >= this ...
MIN_OI = 50           # ... OR open interest >= this (liquid strike, quiet day)
START_EQUITY = 100_000.0


def fillable(vol, oi):
    return vol >= MIN_VOL or oi >= MIN_OI


# --------------------------------------------------------------- state ------

def load_state():
    if os.path.exists(STATE):
        return json.load(open(STATE))
    return dict(start_date=str(date.today()), start_equity=START_EQUITY,
                cash=START_EQUITY, positions=[], realized_pnl=0.0, last_run=None)


def save_state(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    s["last_run"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    json.dump(s, open(STATE, "w"), indent=2)


def log_trade(row):
    row = {**row, "date": str(date.today())}
    hdr_ = not os.path.exists(TRADES)
    pd.DataFrame([row]).to_csv(TRADES, mode="a", header=hdr_, index=False)


# ------------------------------------------------------------- data ---------

def close_on(tk, d, h):
    """Underlying close on/just-before date d (settlement price)."""
    import requests
    r = requests.get(f"https://api.public.com/userapigateway/historicdata/"
                     f"EQUITY/{tk}/YEAR", headers=h, timeout=20)
    bars = r.json().get("regularMarket", {}).get("bars", [])
    prev = None
    for b in bars:
        bd = pd.Timestamp(b["timestamp"]).date()
        if bd <= d:
            prev = float(b["close"])
        else:
            break
    return prev


# ---------------------------------------------------- lifecycle steps -------

def settle_expirations(s, h, log):
    """Process every option position whose expiry has passed."""
    today = date.today()
    keep, new_shares = [], []
    puts_calls = [p for p in s["positions"] if p["kind"] in ("put", "call")]
    others = [p for p in s["positions"] if p["kind"] == "shares"]
    for p in puts_calls:
        exp = pd.Timestamp(p["expiry"]).date()
        if exp >= today:
            keep.append(p); continue
        sp = close_on(p["ticker"], exp, h)
        if sp is None:
            keep.append(p); continue
        n = p["qty"]
        if p["kind"] == "put":
            if sp < p["strike"]:                          # assigned
                s["cash"] -= p["strike"] * 100 * n
                new_shares.append(dict(kind="shares", ticker=p["ticker"],
                                       qty=n * 100, basis=p["strike"] - p["credit"],
                                       opened=str(today), assign_close=sp,
                                       has_call=False))
                log.append(f"ASSIGNED {p['ticker']} {n}x {p['strike']}P @ exp "
                           f"${sp:.2f} -> hold {n*100}sh basis "
                           f"${p['strike']-p['credit']:.2f}")
                log_trade(dict(ticker=p["ticker"], action="ASSIGNED",
                               qty=n, plan_price=p["strike"], fill_price=sp,
                               status="assigned"))
            else:                                         # expired OTM (win)
                log.append(f"PUT EXPIRED OTM {p['ticker']} {p['strike']}P "
                           f"(kept ${p['credit']*100*n:.0f})")
                log_trade(dict(ticker=p["ticker"], action="SELL_PUT",
                               qty=n, plan_price=p["credit"], fill_price=p["credit"],
                               status="expired"))
        else:  # call
            sh = next((x for x in others if x["ticker"] == p["ticker"]), None)
            if sp > p["strike"] and sh:                   # called away
                s["cash"] += p["strike"] * 100 * n
                others.remove(sh)
                log.append(f"CALLED AWAY {p['ticker']} @ ${p['strike']:.2f} "
                           f"({n*100}sh sold) — cycle closed")
                log_trade(dict(ticker=p["ticker"], action="CALLED_AWAY",
                               qty=n, plan_price=p["strike"], fill_price=sp,
                               status="called_away"))
            else:                                         # call expired OTM
                if sh:
                    sh["has_call"] = False
                log.append(f"CALL EXPIRED OTM {p['ticker']} {p['strike']}C "
                           f"(kept ${p['credit']*100*n:.0f}); re-writable")
                log_trade(dict(ticker=p["ticker"], action="SELL_CALL",
                               qty=n, plan_price=p["credit"], fill_price=p["credit"],
                               status="expired"))
    s["positions"] = keep + others + new_shares


def manage_shares(s, cfg, h, log):
    """Bail (optional) then write covered calls on un-called assigned shares."""
    exp = target_expiration(cfg)
    for sh in [p for p in s["positions"] if p["kind"] == "shares" and not p["has_call"]]:
        tk, n = sh["ticker"], sh["qty"] // 100
        spot, _ = equity_stats(tk, h)
        if spot is None:
            continue
        if cfg.bail_frac is not None and spot <= cfg.bail_frac * sh["assign_close"]:
            s["cash"] += spot * 100 * n
            s["realized_pnl"] += (spot - sh["basis"]) * 100 * n
            s["positions"].remove(sh)
            log.append(f"BAIL {tk}: spot ${spot:.2f} <= {cfg.bail_frac:.0%} of "
                       f"assign ${sh['assign_close']:.2f} — sold {n*100}sh")
            log_trade(dict(ticker=tk, action="BAIL", qty=n, plan_price=spot,
                           fill_price=spot, status="bail"))
            continue
        if exp is None:
            continue
        ch = option_chain(tk, exp, h)
        cc = pick_contract(ch, "C", max(sh["basis"], spot), want_at_least=sh["basis"])
        if cc is None:
            log.append(f"NO CC {tk}: no strike >= basis ${sh['basis']:.2f} (trap — hold)")
            continue
        strike, mid, bid, vol, oi = cc
        if mid <= 0.02 or not fillable(vol, oi):
            log.append(f"NO CC {tk}: best call illiquid (vol {int(vol)}/oi {int(oi)}) (hold)")
            continue
        s["cash"] += mid * 100 * n
        s["positions"].append(dict(kind="call", ticker=tk, strike=strike,
                                   expiry=exp.isoformat(), qty=n, credit=mid,
                                   opened=str(date.today())))
        sh["has_call"] = True
        log.append(f"SELL CC {tk} {n}x {strike}C @ ${mid:.2f} (vol {int(vol)}) "
                   f"exp {exp}")
        log_trade(dict(ticker=tk, action="SELL_CALL", qty=n, plan_price=mid,
                       fill_price=mid, status="open"))


def reserved(s):
    return sum(p["strike"] * 100 * p["qty"] for p in s["positions"] if p["kind"] == "put")


def enter(s, cfg, tok, equity, log):
    held = {p["ticker"] for p in s["positions"]}
    cands, _ = entry_candidates(cfg, held, tok)
    deployable = s["cash"] - reserved(s)
    for c in cands:
        if not fillable(c["volume"], c["open_interest"]):
            continue
        per = c["strike"] * 100
        n = int(min(cfg.alloc * equity, deployable) // per)
        if n < 1:
            continue
        s["cash"] += c["mid"] * 100 * n
        s["positions"].append(dict(kind="put", ticker=c["ticker"], strike=c["strike"],
                                   expiry=c["exp"], qty=n, credit=c["mid"],
                                   opened=str(date.today())))
        deployable -= per * n
        log.append(f"SELL PUT {c['ticker']} {n}x {c['strike']}P @ ${c['mid']:.2f} "
                   f"(vol {c['volume']}, yield {c['ann_yield']}) exp {c['exp']}")
        log_trade(dict(ticker=c["ticker"], action="SELL_PUT", qty=n,
                       plan_price=c["mid"], fill_price=c["mid"], status="open"))


def mark_equity(s, h):
    """Net-liq = cash + shares*spot - short-option marks (fetched live)."""
    eq = s["cash"]; chains = {}
    for p in s["positions"]:
        if p["kind"] == "shares":
            spot, _ = equity_stats(p["ticker"], h)
            if spot:
                eq += spot * p["qty"]
        else:
            key = (p["ticker"], p["expiry"])
            if key not in chains:
                chains[key] = option_chain(p["ticker"], pd.Timestamp(p["expiry"]).date(), h)
            m = get_mark(chains[key], "P" if p["kind"] == "put" else "C", p["strike"])
            if m is not None:
                eq -= m * 100 * p["qty"]
    return eq


# ----------------------------------------------------------------- main -----

def run(cfg, email_to=None):
    s = load_state()
    tok = token(); h = hdr(tok)
    log = []
    settle_expirations(s, h, log)
    manage_shares(s, cfg, h, log)
    equity = mark_equity(s, h)                    # equity BEFORE new entries
    enter(s, cfg, tok, equity, log)
    equity = mark_equity(s, h)                    # after entries
    save_state(s)

    # equity log for the tracker
    pd.DataFrame([dict(date=str(date.today()), account_value=round(equity, 2),
                       cash=round(s["cash"], 2))]).to_csv(
        EQ_LOG, mode="a", header=not os.path.exists(EQ_LOG), index=False)

    ret = equity / s["start_equity"] - 1
    npos = {k: sum(1 for p in s["positions"] if p["kind"] == k)
            for k in ("put", "shares", "call")}
    body = [f"WHEEL FORWARD SIM — {date.today()}",
            f"equity ${equity:,.0f}  ({ret:+.1%} since {s['start_date']})   "
            f"cash ${s['cash']:,.0f}   realized ${s['realized_pnl']:+,.0f}",
            f"positions: {npos['put']} puts, {npos['shares']} share-lots, "
            f"{npos['call']} covered calls",
            "", "ACTIONS THIS RUN:" if log else "no actions this run."]
    body += [f"  - {x}" for x in log]
    report = "\n".join(body)
    print(report)
    if email_to:
        tag = "actions" if log else "no action"
        send_email(email_to, f"[wheel sim {tag}] {date.today()} "
                   f"${equity:,.0f} ({ret:+.1%})", report)
    return report


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Automated wheel forward simulator")
    ap.add_argument("--bail", type=float, default=None)
    ap.add_argument("--email")
    a = ap.parse_args()
    CFG.bail_frac = a.bail
    run(CFG, a.email or os.environ.get("WHEEL_EMAIL_TO"))
