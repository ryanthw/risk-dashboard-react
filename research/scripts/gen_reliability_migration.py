"""Generate a Supabase migration that upserts the current ticker_reliability.json
into public.earnings_reliability. Idempotent (ON CONFLICT DO UPDATE). Re-run after
any reliability regeneration to refresh the seed. Usage: gen_reliability_migration.py <out.sql>"""
import os, json, sys
OUT = os.path.join(os.path.dirname(__file__), "..", "out")
rel = json.load(open(os.path.join(OUT, "ticker_reliability.json")))
dest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "..", "..", "supabase", "migrations", "0003_earnings_reliability_expand.sql")

def num(v):
    try:
        f = float(v)
        return "null" if f != f else f"{f:.4f}"
    except (TypeError, ValueError):
        return "null"

rows = []
for r in rel:
    t = str(r["ticker"]).replace("'", "''")
    rows.append(f"('{t}',{int(r['n'])},{num(r.get('fly_win'))},{num(r.get('fly_mean_ror'))},"
                f"{num(r.get('straddle_win'))},{num(r.get('straddle_mean'))},{num(r.get('avg_implied'))},"
                f"{num(r.get('avg_actual'))},{num(r.get('atm_iv'))},{num(r.get('premium_richness'))})")
values = ",\n  ".join(rows)
sql = f"""-- ============================================================================
-- Earnings reliability — expanded universe ({len(rows)} names).
-- Regenerated from the DoltHub option backtest over the full ~2,282-symbol
-- universe (S&P 500 + the rest of the DoltHub option universe), real-data-only,
-- T+1..T+3 exits, >=3 valid events per name. Idempotent upsert — safe to re-run.
-- Regenerate via research/scripts/gen_reliability_migration.py.
-- ============================================================================
insert into public.earnings_reliability
  (ticker,n,fly_win,fly_mean_ror,straddle_win,straddle_mean,avg_implied,avg_actual,atm_iv,premium_richness)
values
  {values}
on conflict (ticker) do update set
  n=excluded.n, fly_win=excluded.fly_win, fly_mean_ror=excluded.fly_mean_ror,
  straddle_win=excluded.straddle_win, straddle_mean=excluded.straddle_mean,
  avg_implied=excluded.avg_implied, avg_actual=excluded.avg_actual,
  atm_iv=excluded.atm_iv, premium_richness=excluded.premium_richness,
  updated_at=now();
"""
open(dest, "w").write(sql)
print(f"wrote {len(rows)}-row upsert -> {dest}")
