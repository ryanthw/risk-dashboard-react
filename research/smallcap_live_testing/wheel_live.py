"""Wheel strategy — formalized live/paper order engine.

Turns the backtested policy into an explicit, auditable rule set that, given
(a) live market data (Public API) and (b) your current positions, emits a
reviewable list of orders. It does NOT auto-execute — it ELICITS orders you
place in a paper account (or later wire to a broker API).

================================ THE POLICY ================================
Derived from research/smallcap/PLAN.md (2022-26 backtest + Monte-Carlo).

UNIVERSE (point-in-time):  optionable US names from universe_expanded.csv that
  are CURRENTLY trading < PRICE_MAX ($10). A name is only eligible while it is
  actually cheap (this is the survivorship-free gate; a name that ran >$10 is
  simply not eligible until/unless it comes back).

ANTI-RECOVERY FILTER (skip likely go-to-zero names):
  keep only if  dd252  <= DD_MAX (0.60)   — not >60% below its 1y high (knife)
           AND  dilution_1y <= DIL_MAX (2.0) — split-adj shares not >2x in 1y
                                               (death-spiral financing)
           AND  ticker not in BIOTECH_BINARY — hard exclude binary-catalyst
                biotech/pharma (their tail is a single FDA/trial print,
                unpredictable from price; user never trades these).
           AND  TTM revenue >= REV_MIN ($10M) — skip PRE-REVENUE story stocks
                (SPCE/MVIS/EVTL-type): the residual go-to-zero class that dd +
                dilution miss. NB: it's a revenue-EXISTENCE floor, not a
                profitability screen — the whole universe is unprofitable
                (BBAI/SOUN/miners all deep operating losses); requiring profit
                would delete the strategy. Real revenue + low dilution = "a
                real business not diluting to death", the actual recover vs
                ruin split.

ENTRY (cash-secured put):
  - target the monthly expiration with DTE in [DTE_MIN, DTE_MAX] (~30-45d)
  - strike = nearest listed strike to MONEYNESS (0.90) * spot
  - require annualized premium yield  credit/strike * 365/dte >= PREM_MIN (0.80)
  - NEVER hold a short put through EARNINGS: skip if the name's next earnings
    date falls on/before the expiration (yfinance; UNVERIFIED dates are flagged,
    not silently traded). Both exclusions are on by default (CONFIG toggles).
  - credit is quoted conservatively at the option's mid (fill as a limit at mid)

EXIT / MANAGEMENT (hold-and-CC = the "ccbasis" policy; best risk-adj in MC):
  - short put expires OTM  -> nothing (capital frees, name re-eligible)
  - short put finishes ITM -> allow ASSIGNMENT (no defensive roll — as tested)
  - assigned shares        -> sell a covered CALL, strike = nearest listed
                              >= basis, same DTE window; roll monthly until
                              called away at/above basis
  - covered call ITM       -> called away (position closed, capital frees)
  - OPTIONAL bail (BAIL_FRAC, default None): if an assigned name's spot falls
    <= BAIL_FRAC * assignment-day close, LIQUIDATE the shares (bail30 = 0.70).
    Off by default: MC showed pure hold-and-CC had the best CAGR/DD; bail is
    the tail-safety variant (lower worst-case, slightly lower CAGR).

CAPITAL DEPLOYMENT:
  - ONE position per underlying at a time (no pyramiding).
  - size each new CSP at ALLOC (0.10) of total equity, capped by free cash;
    contracts = floor(min(ALLOC*equity, cash) / (strike*100)).
  - fully cash-secured (collateral = strike*100*contracts).
  - deploy highest-premium-yield candidates first until cash is exhausted.

All thresholds are the prespecified backtest values — change them in CONFIG,
not inline, so the live rules stay traceable to the research.
===========================================================================
"""
from __future__ import annotations

import argparse
import os
import smtplib
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from email.message import EmailMessage
from pathlib import Path

import pandas as pd
import requests

# Repo-root-relative paths so this runs from any cwd (e.g. cron/CI). This file
# lives at <repo>/research/smallcap_live_testing/wheel_live.py.
ROOT = Path(__file__).resolve().parents[2]

# Inlined from research/scripts/recovery_filter.py (the research source of truth
# — keep in sync) so this live package has NO cross-package import, i.e. CI only
# needs this folder + universe_expanded.csv + shares_adj.parquet.
BIOTECH_BINARY = {"OCGN", "INO", "ATAI", "DNA", "NVAX", "SAVA", "BNGO",
                  "VXRT", "CDXC", "CRTX", "ATNF", "CYTO"}

BASE = "https://api.public.com/userapigateway"
ACCT = "5OG07032"                       # market-data account (data only)
UNIVERSE = str(ROOT / "research" / "smallcap" / "universe_expanded.csv")
SHARES = str(ROOT / "research" / "data" / "shares_adj.parquet")
ORDERS_DIR = Path(__file__).resolve().parent / "orders"


@dataclass
class Config:
    price_max: float = 10.0             # point-in-time eligibility ceiling
    dd_max: float = 0.60                # anti-recovery: max drawdown from 1y high
    dil_max: float = 2.0                # anti-recovery: max trailing-1y share growth
    prem_min: float = 0.80              # min annualized premium yield to enter
    moneyness: float = 0.90             # target put strike = moneyness * spot
    dte_min: int = 25
    dte_max: int = 50
    alloc: float = 0.10                 # fraction of equity per new position
    bail_frac: float | None = None      # None = pure hold-and-CC; 0.70 = bail30
    haircut: float = 0.10               # display a conservative net credit too
    exclude_biotech: bool = True        # never sell puts on binary-catalyst biotech
    exclude_earnings: bool = True       # never hold a short put through earnings
    exclude_pre_revenue: bool = True    # skip pre-revenue story stocks (ruin tail)
    rev_min: float = 10e6               # TTM revenue floor ($10M) for eligibility


CFG = Config()

# --------------------------------------------------------------- data -------

def token() -> str:
    key = os.environ.get("PUBLI_API_KEY")
    if not key:                          # fall back to ~/.zshrc (not sourced by scripts)
        import re
        for ln in open(os.path.expanduser("~/.zshrc")):
            m = re.match(r'export PUBLI_API_KEY="?([^"]+)"?', ln)
            if m:
                key = m.group(1)
    r = requests.post(f"{BASE.replace('userapigateway','userapiauthservice')}"
                      "/personal/access-tokens",
                      json={"validityInMinutes": 60, "secret": key}, timeout=20)
    return r.json()["accessToken"]


def hdr(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def equity_stats(tk, h):
    """spot + 252d high from Public daily bars -> (spot, dd252)."""
    r = requests.get(f"{BASE}/historicdata/EQUITY/{tk}/YEAR", headers=h, timeout=20)
    bars = r.json().get("regularMarket", {}).get("bars", [])
    if not bars:
        return None, None
    closes = [float(b["close"]) for b in bars]
    spot = closes[-1]
    return spot, 1 - spot / max(closes)


def third_friday(y, m):
    d = date(y, m, 15)
    return d + timedelta((4 - d.weekday()) % 7)


def target_expiration(cfg):
    today = date.today()
    for k in range(0, 4):
        m = today.month + k
        y = today.year + (m - 1) // 12
        e = third_friday(y, (m - 1) % 12 + 1)
        if cfg.dte_min <= (e - today).days <= cfg.dte_max:
            return e
    return None


def option_chain(tk, exp, h):
    r = requests.post(f"{BASE}/marketdata/{ACCT}/option-chain", headers=h,
                      json={"instrument": {"symbol": tk, "type": "EQUITY"},
                            "expirationDate": exp.isoformat()}, timeout=25)
    return r.json()


def osi(tk, exp, right, strike):
    return f"{tk}{exp:%y%m%d}{right}{int(round(strike * 1000)):08d}"


def dilution_1y(tk, shd):
    s = shd.get(tk)
    if s is None or len(s) < 2:
        return None
    now = s.iloc[-1]
    prior = s.loc[:s.index[-1] - pd.Timedelta(days=365)]
    base = prior.iloc[-1] if len(prior) else s.iloc[0]
    return now / base - 1 if base > 0 else None


def fundamentals(tk):
    """One yfinance pull -> (ttm_revenue, next_earnings_date, earn_verified).
    Live current data (no look-ahead when trading now)."""
    rev, earn, verified = None, None, False
    try:
        import yfinance as yf
        t = yf.Ticker(tk)
        rev = t.info.get("totalRevenue")
        df = t.get_earnings_dates(limit=12)
        if df is not None and len(df):
            idx = pd.to_datetime(df.index).tz_localize(None)
            fut = idx[idx >= pd.Timestamp.now().normalize()]
            earn, verified = (fut.min().date() if len(fut) else None), True
    except Exception:
        pass
    return rev, earn, verified


# ----------------------------------------------------- entry candidates -----

def pick_contract(chain, side, target_strike, want_at_least=None):
    """Nearest listed strike to target (calls: >= want_at_least if given)."""
    legs = chain.get("puts" if side == "P" else "calls") or []
    best = None
    for c in legs:
        od = c.get("optionDetails", {})
        try:
            k = float(od["strikePrice"])
            mid = float(od.get("midPrice") or 0) or (
                (float(c["bid"]) + float(c["ask"])) / 2)
        except (KeyError, TypeError, ValueError):
            continue
        if want_at_least is not None and k < want_at_least:
            continue
        d = abs(k - target_strike)
        if best is None or d < best[0]:
            best = (d, k, mid, float(c.get("bid") or 0),
                    float(c.get("volume") or 0), float(c.get("openInterest") or 0))
    return None if best is None else best[1:]  # (strike, mid, bid, volume, oi)


def get_mark(chain, side, strike):
    """Current mid for an exact listed strike (marking open positions)."""
    for c in chain.get("puts" if side == "P" else "calls") or []:
        od = c.get("optionDetails", {})
        try:
            if abs(float(od["strikePrice"]) - strike) < 1e-6:
                return float(od.get("midPrice") or 0) or (
                    (float(c["bid"]) + float(c["ask"])) / 2)
        except (KeyError, TypeError, ValueError):
            continue
    return None


def entry_candidates(cfg, held_names, tok):
    h = hdr(tok)
    exp = target_expiration(cfg)
    if exp is None:
        return [], None
    dte = (exp - date.today()).days
    shd = ({t: g.set_index("date")["adj_shares"].sort_index()
            for t, g in pd.read_parquet(SHARES).groupby("ticker")}
           if os.path.exists(SHARES) else {})
    u = pd.read_csv(UNIVERSE)
    biotech = set(BIOTECH_BINARY) | set(
        u.loc[u.theme == "biotech-binary", "ticker"])
    names = u[u.optionable_now].ticker.tolist()
    out, skipped = [], []
    for tk in names:
        if tk in held_names:
            skipped.append((tk, "already held")); continue
        if cfg.exclude_biotech and tk in biotech:
            skipped.append((tk, "biotech binary-catalyst (excluded)")); continue
        spot, dd = equity_stats(tk, h)
        if spot is None:
            skipped.append((tk, "no price")); continue
        if spot >= cfg.price_max:
            skipped.append((tk, f"spot ${spot:.2f} >= ${cfg.price_max:.0f}")); continue
        if dd is not None and dd > cfg.dd_max:
            skipped.append((tk, f"dd252 {dd:.0%} > {cfg.dd_max:.0%} (knife)")); continue
        dil = dilution_1y(tk, shd)
        if dil is not None and dil > cfg.dil_max:
            skipped.append((tk, f"dilution {dil:+.0%} > {cfg.dil_max:.0%}")); continue
        ch = option_chain(tk, exp, h)
        pc = pick_contract(ch, "P", cfg.moneyness * spot)
        if pc is None:
            skipped.append((tk, "no put strike")); continue
        strike, mid, bid, vol, oi = pc
        if strike < 0.5 or mid <= 0.02:
            skipped.append((tk, "no tradeable strike/credit")); continue
        yld = mid / strike * 365 / dte
        if yld < cfg.prem_min:
            skipped.append((tk, f"yield {yld:.2f} < {cfg.prem_min}")); continue
        earn_note = "n/a"
        if cfg.exclude_earnings or cfg.exclude_pre_revenue:
            rev, earn, verified = fundamentals(tk)
            if cfg.exclude_pre_revenue and rev is not None and rev < cfg.rev_min:
                skipped.append((tk, f"pre-revenue (TTM ${rev/1e6:.0f}M < "
                                f"${cfg.rev_min/1e6:.0f}M)")); continue
            if cfg.exclude_earnings and earn is not None and date.today() < earn <= exp:
                skipped.append((tk, f"earnings {earn} within cycle (skip)")); continue
            earn_note = "clear" if verified else "UNVERIFIED-check-manually"
        out.append(dict(ticker=tk, spot=round(spot, 2), dd252=round(dd, 2),
                        dilution=None if dil is None else round(dil, 2),
                        exp=exp.isoformat(), dte=dte, strike=strike,
                        mid=round(mid, 2), bid=round(bid, 2),
                        ann_yield=round(yld, 2), earnings=earn_note,
                        volume=int(vol), open_interest=int(oi),
                        symbol=osi(tk, exp, "P", strike),
                        collateral=strike * 100))
    out.sort(key=lambda r: -r["ann_yield"])
    return out, skipped


# --------------------------------------------------- position management ----

def manage(positions: pd.DataFrame, cfg, tok):
    """Emit exit/CC/bail orders for existing positions."""
    if positions is None or not len(positions):
        return []
    h = hdr(tok); orders = []
    exp = target_expiration(cfg)
    for _, p in positions.iterrows():
        tk = p["ticker"]; typ = p["type"]
        spot, _ = equity_stats(tk, h)
        if typ == "shares":                                 # assigned -> CC / bail
            basis = float(p["basis"])
            if cfg.bail_frac is not None and "assign_close" in p and pd.notna(p["assign_close"]):
                if spot is not None and spot <= cfg.bail_frac * float(p["assign_close"]):
                    orders.append(dict(action="SELL_SHARES(bail)", ticker=tk,
                                       qty=int(p["qty"]), limit="market",
                                       rationale=f"bail: spot ${spot:.2f} <= "
                                       f"{cfg.bail_frac:.0%} of assign close "
                                       f"${float(p['assign_close']):.2f}"))
                    continue
            if str(p.get("has_open_call", "")).lower() in ("1", "true", "yes"):
                continue                                     # CC already written
            if exp is None:
                continue
            ch = option_chain(tk, exp, h)
            cc = pick_contract(ch, "C", max(basis, spot or basis),
                               want_at_least=basis)
            if cc is None:
                orders.append(dict(action="NO_CC(trap)", ticker=tk, qty=int(p["qty"]),
                                   limit="-", rationale=f"no call strike >= basis "
                                   f"${basis:.2f} (CC trap — hold)"))
                continue
            strike, mid, bid, vol, oi = cc
            orders.append(dict(action="SELL_CALL", ticker=tk,
                               symbol=osi(tk, exp, "C", strike),
                               qty=int(p["qty"]), limit=round(mid, 2),
                               rationale=f"covered call @ ${strike:g} (>= basis "
                               f"${basis:.2f}), exp {exp}, credit ~${mid:.2f}"))
        elif typ == "put":                                   # informational
            dte = (pd.Timestamp(p["expiry"]).date() - date.today()).days
            if spot is not None and spot < float(p["strike"]) and dte <= 2:
                orders.append(dict(action="EXPECT_ASSIGNMENT", ticker=tk,
                                   qty=int(p["qty"]), limit="-",
                                   rationale=f"put ITM (spot ${spot:.2f} < strike "
                                   f"${float(p['strike']):g}), {dte}d left — "
                                   f"let assign, then covered calls"))
        elif typ == "call":
            dte = (pd.Timestamp(p["expiry"]).date() - date.today()).days
            if spot is not None and spot > float(p["strike"]) and dte <= 2:
                orders.append(dict(action="EXPECT_CALLED_AWAY", ticker=tk,
                                   qty=int(p["qty"]), limit="-",
                                   rationale=f"call ITM — shares called away at "
                                   f"${float(p['strike']):g}, position closes"))
    return orders


# ----------------------------------------------------------- allocation -----

def allocate(cands, equity, cash, cfg):
    orders = []; free = cash
    for c in cands:
        per = c["strike"] * 100
        n = int(min(cfg.alloc * equity, free) // per)
        if n < 1:
            continue
        orders.append(dict(action="SELL_PUT", ticker=c["ticker"],
                           symbol=c["symbol"], qty=n, limit=c["mid"],
                           strike=c["strike"], exp=c["exp"],
                           ann_yield=c["ann_yield"], earnings=c["earnings"],
                           credit=round(c["mid"] * n * 100, 0),
                           collateral=round(per * n, 0),
                           rationale=f"CSP {c['ticker']} @ ${c['strike']:g} "
                           f"(spot ${c['spot']}, {int(c['dd252']*100)}% off high, "
                           f"yield {c['ann_yield']}, earnings:{c['earnings']}), "
                           f"exp {c['exp']}"))
        free -= per * n
    return orders, free


# ------------------------------------------------------------- delivery -----

ACTIONABLE = {"SELL_PUT", "SELL_CALL", "SELL_SHARES(bail)",
              "EXPECT_ASSIGNMENT", "EXPECT_CALLED_AWAY"}


def send_email(to, subject, body):
    """SMTP send via env creds WHEEL_SMTP_USER / WHEEL_SMTP_PASS (Gmail app pw)."""
    user, pw = os.environ.get("WHEEL_SMTP_USER"), os.environ.get("WHEEL_SMTP_PASS")
    if not (user and pw):
        print("[email skipped: set WHEEL_SMTP_USER / WHEEL_SMTP_PASS]")
        return False
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = user, to, subject
    m.set_content(body)
    with smtplib.SMTP("smtp.gmail.com", 587) as s:
        s.starttls(); s.login(user, pw); s.send_message(m)
    return True


# ----------------------------------------------------------------- main -----

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Wheel paper-trading order engine")
    ap.add_argument("--equity", type=float, required=True, help="total account equity $")
    ap.add_argument("--cash", type=float, required=True, help="cash free for new collateral $")
    ap.add_argument("--positions", help="CSV of current positions (see docstring)")
    ap.add_argument("--bail", type=float, default=None, help="bail_frac, e.g. 0.70 (default: pure hold-and-CC)")
    ap.add_argument("--email", help="email address to send the plan to")
    ap.add_argument("--only-if-actionable", action="store_true",
                    help="only print/email when there are orders to place (for cron)")
    ap.add_argument("--no-save", action="store_true", help="don't write the dated orders CSV")
    a = ap.parse_args()
    CFG.bail_frac = a.bail

    tok = token()
    pos = pd.read_csv(a.positions) if a.positions else None
    held = set(pos["ticker"]) if pos is not None else set()

    mgmt = manage(pos, CFG, tok)
    cands, skipped = entry_candidates(CFG, held, tok)
    entries, cash_left = allocate(cands, a.equity, a.cash, CFG)
    orders = mgmt + entries
    actionable = any(o["action"] in ACTIONABLE for o in orders)

    L = [f"=== WHEEL ORDER PLAN  {date.today()}  "
         f"(equity ${a.equity:,.0f}, cash ${a.cash:,.0f}, "
         f"exit={'bail'+str(CFG.bail_frac) if CFG.bail_frac else 'hold-and-CC'}) ==="]
    L.append(f"\nMANAGE EXISTING ({len(mgmt)}):")
    for o in mgmt:
        L.append(f"  [{o['action']}] {o['ticker']} x{o.get('qty','')}  "
                 f"{o.get('symbol','')}  lim {o.get('limit','')}  — {o['rationale']}")
    L.append(f"\nNEW ENTRIES ({len(entries)}), deploying "
             f"${a.cash - cash_left:,.0f} of ${a.cash:,.0f}:")
    for o in entries:
        warn = "  ** earnings UNVERIFIED **" if o.get("earnings", "").startswith("UNVERI") else ""
        L.append(f"  [SELL_PUT] {o['ticker']} x{o['qty']} {o['symbol']} @ ${o['limit']} "
                 f"(yield {o['ann_yield']}, credit ~${o['credit']:.0f}, "
                 f"collateral ${o['collateral']:,.0f}){warn}")
    L.append(f"\n  {len(cands)} names passed all filters; {len(skipped)} skipped. "
             f"Cash remaining after plan: ${cash_left:,.0f}")
    report = "\n".join(L)

    if a.only_if_actionable and not actionable:
        print(f"[{date.today()}] no actionable orders — nothing to place today.")
        sys.exit(0)

    print("\n" + report)
    if orders and not a.no_save:
        ORDERS_DIR.mkdir(exist_ok=True)
        out = ORDERS_DIR / f"orders_{date.today()}.csv"
        pd.DataFrame(orders).to_csv(out, index=False)
        print(f"\n-> {out}")
    if a.email:
        tag = "ACTION NEEDED" if actionable else "no action"
        if send_email(a.email, f"[wheel {tag}] {date.today()}", report):
            print(f"[emailed to {a.email}]")
