// Supabase Edge Function: market-data
// Proxies Finnhub (quote / sector / beta) and Yahoo Finance (historical candles)
// so the Finnhub API key stays server-side and browser CORS is avoided.
//
// Deploy:
//   supabase functions deploy market-data
//   supabase secrets set FINNHUB_API_KEY=your_key
//
// The function requires a valid Supabase JWT (verify_jwt is on by default), so
// only authenticated users can call it.

const FINNHUB_KEY = Deno.env.get("FINNHUB_API_KEY") ?? "";
const FINNHUB = "https://finnhub.io/api/v1";
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function finnhubQuote(ticker: string): Promise<number> {
  const r = await fetch(`${FINNHUB}/quote?symbol=${ticker}&token=${FINNHUB_KEY}`);
  const d = await r.json();
  return typeof d.c === "number" ? d.c : 0;
}

async function finnhubProfile(ticker: string): Promise<string> {
  try {
    const r = await fetch(
      `${FINNHUB}/stock/profile2?symbol=${ticker}&token=${FINNHUB_KEY}`,
    );
    const d = await r.json();
    return d.finnhubIndustry || "Unknown";
  } catch {
    return "Unknown";
  }
}

async function finnhubBeta(ticker: string): Promise<number> {
  try {
    const r = await fetch(
      `${FINNHUB}/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB_KEY}`,
    );
    const d = await r.json();
    const beta = d?.metric?.beta;
    return typeof beta === "number" ? beta : 1.0;
  } catch {
    return 1.0;
  }
}

/** Daily closes from Yahoo for the last `days` calendar days. */
async function yahooCloses(ticker: string, days = 180): Promise<number[]> {
  try {
    const range = days <= 35 ? "1mo" : days <= 100 ? "3mo" : days <= 200 ? "6mo" : "1y";
    const r = await fetch(
      `${YAHOO}/${ticker}?range=${range}&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" } },
    );
    const d = await r.json();
    const closes: (number | null)[] =
      d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    return closes.filter((c): c is number => typeof c === "number");
  } catch {
    return [];
  }
}

/** Annualized 30-day historical volatility from daily closes. */
function historicalVol(closes: number[], window = 30): number {
  if (closes.length < window + 1) return 0.3;
  const recent = closes.slice(-(window + 1));
  const logReturns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    logReturns.push(Math.log(recent[i] / recent[i - 1]));
  }
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance =
    logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / logReturns.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const { action, ticker, tickers, days } = await req.json();

    if (action === "quote" && ticker) {
      const sym = String(ticker).toUpperCase();
      const [price, sector, beta, closes] = await Promise.all([
        finnhubQuote(sym),
        finnhubProfile(sym),
        finnhubBeta(sym),
        yahooCloses(sym, 60),
      ]);
      return json({ ticker: sym, price, sector, beta, hv: historicalVol(closes) });
    }

    if (action === "candles" && ticker) {
      const sym = String(ticker).toUpperCase();
      const closes = await yahooCloses(sym, days ?? 180);
      return json({ ticker: sym, closes });
    }

    // Batch closes for correlation matrices.
    if (action === "batch_candles" && Array.isArray(tickers)) {
      const out: Record<string, number[]> = {};
      await Promise.all(
        tickers.map(async (t: string) => {
          const sym = String(t).toUpperCase();
          out[sym] = await yahooCloses(sym, days ?? 180);
        }),
      );
      return json({ closes: out });
    }

    return json({ error: "Invalid action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
