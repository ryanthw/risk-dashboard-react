"""Enumerate the full DoltHub option universe (~2290 symbols), dedupe against the
names we already pulled, and emit a random pilot list of NEW names. Reusable for
the full run (pass --all to emit every new name instead of a pilot sample)."""
import os, json, time, urllib.request, urllib.parse, re, random, sys
DATA = os.path.join(os.path.dirname(__file__), "..", "data")
BASE = "https://www.dolthub.com/api/v1alpha1/post-no-preference/options/master"
SYMS = os.path.join(DATA, "dolthub_symbols.csv")
PILOT = os.path.join(DATA, "pilot_tickers.txt")
ALLNEW = os.path.join(DATA, "new_tickers.txt")

def dq(sql, tries=4):
    u = BASE + "?q=" + urllib.parse.quote(sql)
    for k in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "research"}), timeout=60)
            d = json.load(r)
            if d.get("query_execution_status") == "Success":
                return d["rows"]
        except Exception:
            time.sleep(0.6 * (k + 1))
    return None

# --- 1. enumerate all DoltHub symbols (cached) ---------------------------
if os.path.exists(SYMS):
    syms = [l.strip() for l in open(SYMS) if l.strip()]
    print(f"cached dolthub symbols: {len(syms)}")
else:
    syms, off, PAGE = [], 0, 1000
    while True:
        rows = dq(f"SELECT DISTINCT act_symbol FROM volatility_history ORDER BY act_symbol LIMIT {PAGE} OFFSET {off}")
        if not rows:
            break
        syms += [r["act_symbol"] for r in rows]
        if len(rows) < PAGE:
            break
        off += PAGE
        time.sleep(0.2)
    open(SYMS, "w").write("\n".join(syms) + "\n")
    print(f"enumerated {len(syms)} dolthub symbols -> {SYMS}")

# --- 2. clean to yfinance-compatible equity tickers ----------------------
def clean(s):
    s = s.strip().upper()
    if not re.fullmatch(r"[A-Z]{1,5}", s):   # plain equities only (no indices/prefs/units)
        return None
    return s
clean_syms = sorted({c for c in (clean(s) for s in syms) if c})
print(f"clean equity symbols: {len(clean_syms)} (dropped {len(syms) - len(clean_syms)} non-equity/odd)")

# --- 3. dedupe against names we already pulled ---------------------------
done = set()
dp = os.path.join(DATA, "_done_tickers.json")
if os.path.exists(dp):
    done = set(json.load(open(dp)))
new = [s for s in clean_syms if s not in done]
print(f"already pulled: {len(done & set(clean_syms))} | NEW names available: {len(new)}")

# --- 4. emit pilot (or all) ---------------------------------------------
if "--all" in sys.argv:
    open(ALLNEW, "w").write("\n".join(new) + "\n")
    print(f"wrote ALL {len(new)} new names -> {ALLNEW}")
else:
    n = 300
    for a in sys.argv:
        if a.startswith("--pilot="):
            n = int(a.split("=")[1])
    random.seed(42)
    pilot = sorted(random.sample(new, min(n, len(new))))
    open(PILOT, "w").write("\n".join(pilot) + "\n")
    print(f"wrote pilot of {len(pilot)} new names -> {PILOT}")
    print("sample:", pilot[:15])
