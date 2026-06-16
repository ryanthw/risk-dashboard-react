"""Generate a Supabase migration that upserts the current ticker_reliability.json
into public.earnings_reliability, adding the iron-CONDOR reliability columns
(condor_n / condor_win / condor_mean_ror) alongside the existing butterfly stats.
Idempotent (ADD COLUMN IF NOT EXISTS + ON CONFLICT DO UPDATE). Re-run after any
reliability regeneration. Usage: gen_reliability_migration.py <out.sql>"""
import os, json, sys
OUT = os.path.join(os.path.dirname(__file__), "..", "out")
rel = json.load(open(os.path.join(OUT, "ticker_reliability.json")))
dest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "..", "..", "supabase", "migrations", "0004_earnings_condor.sql")

def num(v):
    try:
        f = float(v)
        return "null" if f != f else f"{f:.4f}"
    except (TypeError, ValueError):
        return "null"

def intnull(v):
    try:
        return str(int(v))
    except (TypeError, ValueError):
        return "null"

rows = []
for r in rel:
    t = str(r["ticker"]).replace("'", "''")
    rows.append(f"('{t}',{int(r['n'])},{num(r.get('fly_win'))},{num(r.get('fly_mean_ror'))},"
                f"{intnull(r.get('condor_n'))},{num(r.get('condor_win'))},{num(r.get('condor_mean_ror'))},"
                f"{num(r.get('straddle_win'))},{num(r.get('straddle_mean'))},{num(r.get('avg_implied'))},"
                f"{num(r.get('avg_actual'))},{num(r.get('atm_iv'))},{num(r.get('premium_richness'))})")
values = ",\n  ".join(rows)
sql = f"""-- ============================================================================
-- Earnings reliability — add iron-CONDOR stats ({len(rows)} names).
-- The scanner now offers a butterfly|condor structure toggle; the condor is the
-- smoother backtested structure (PF 2.4, positive every quarter). Columns
-- condor_n/condor_win/condor_mean_ror come from the same DoltHub backtest
-- (Δ16 short body / Δ5 wings). Idempotent — safe to re-run.
-- Regenerate via research/scripts/gen_reliability_migration.py.
-- ============================================================================
alter table public.earnings_reliability add column if not exists condor_n int;
alter table public.earnings_reliability add column if not exists condor_win numeric;
alter table public.earnings_reliability add column if not exists condor_mean_ror numeric;

insert into public.earnings_reliability
  (ticker,n,fly_win,fly_mean_ror,condor_n,condor_win,condor_mean_ror,
   straddle_win,straddle_mean,avg_implied,avg_actual,atm_iv,premium_richness)
values
  {values}
on conflict (ticker) do update set
  n=excluded.n, fly_win=excluded.fly_win, fly_mean_ror=excluded.fly_mean_ror,
  condor_n=excluded.condor_n, condor_win=excluded.condor_win, condor_mean_ror=excluded.condor_mean_ror,
  straddle_win=excluded.straddle_win, straddle_mean=excluded.straddle_mean,
  avg_implied=excluded.avg_implied, avg_actual=excluded.avg_actual,
  atm_iv=excluded.atm_iv, premium_richness=excluded.premium_richness,
  updated_at=now();
"""
open(dest, "w").write(sql)
print(f"wrote {len(rows)}-row upsert (+condor cols) -> {dest}")
