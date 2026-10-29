/**
 * Render a ReportModel as an email: subject, HTML body, plain-text fallback.
 *
 * Inline styles and nested tables only — email clients strip <style> blocks
 * and most layout CSS unevenly, and a report that renders as a wall of text in
 * one client is a report that stops being read. Bars are table cells rather
 * than images so they survive clients that block images; the one true chart
 * (growth vs SPY) is a PNG with every value it shows also in the tiles above
 * it. The plain-text part carries the same content for clients that show it.
 *
 * Palette: the dashboard's (index.css, components/charts/theme.ts) — its
 * near-black canvas for the header band, brand blue and amber for the two
 * series — with text colors deepened to clear 4.5:1 on white.
 */
import { fmtUsd } from "@/lib/format";
import type { ActionPriority } from "@/engine/actions";
import type { InsightTone } from "@/engine/insights";
import { CONCENTRATION_PCT } from "@/engine/actions";
import { BENCHMARK } from "./benchmark";
import { EMAIL_PALETTE } from "./charts";
import type { ReportModel, WindowReturn } from "./portfolioReport";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Where the HTML finds its images. In the sent email these are `cid:`
 * references to inline attachments; in a local preview, file names next to
 * the HTML. Omit one and its image is left out.
 */
export interface ImageRefs {
  logo?: string;
  growth?: string;
}

/** Escape for HTML text and double-quoted attributes. Every interpolated string goes through this. */
export const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const signedPct = (x: number | null, digits = 1) =>
  x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;
const signedPts = (x: number | null) =>
  x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pts`;
const signedUsd = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${fmtUsd(x)}`);
const px = (x: number | null) => (x == null ? "—" : `$${x.toFixed(2)}`);
const dte = (d: number | null) => (d == null ? "" : `${Math.max(Math.floor(d), 0)}d`);

const C = {
  canvas: "#0b0e14", // dashboard background / logo tile
  headerText: "#e6edf3",
  headerMuted: "#8b97a8",
  page: "#eef1f5",
  card: "#ffffff",
  panel: "#f6f8fa",
  border: "#e1e6ec",
  ink: EMAIL_PALETTE.ink,
  muted: EMAIL_PALETTE.muted,
  brand: EMAIL_PALETTE.book,
  bench: EMAIL_PALETTE.benchmark,
  gain: "#12805c",
  loss: "#c93b3a",
  warn: "#8a5a00",
};
const FONT = "-apple-system,'Segoe UI',Inter,Helvetica,Arial,sans-serif";
const MONO = "Consolas,'SF Mono',Menlo,monospace";
const tone = (x: number | null) => (x == null ? C.muted : x >= 0 ? C.gain : C.loss);

/** Priority badges carry a word, never color alone. */
const PRIORITY: Record<ActionPriority, { label: string; fg: string; bg: string }> = {
  high: { label: "HIGH", fg: "#a12a29", bg: "#fdecec" },
  medium: { label: "REVIEW", fg: C.warn, bg: "#fff3dc" },
  low: { label: "WATCH", fg: C.muted, bg: "#eef1f5" },
};
const TONE: Record<InsightTone, { label: string; fg: string }> = {
  negative: { label: "Caution", fg: C.loss },
  unknown: { label: "Unknown", fg: C.warn },
  positive: { label: "Working", fg: C.gain },
  neutral: { label: "Note", fg: C.muted },
};

export function renderSubject(m: ReportModel): string {
  const r = (l: string) => m.returns.find((x) => x.label === l);
  const one = r("1M");
  const three = r("3M");
  const act = m.actions.filter((a) => a.priority !== "low").length;
  const urgent = m.actions.some((a) => a.priority === "high");
  const vs = (w: WindowReturn | undefined) =>
    `${signedPct(w?.ret ?? null)}${w?.benchmark != null ? ` (${BENCHMARK} ${signedPct(w.benchmark)})` : ""}`;
  return (
    `[${m.portfolioName}] ${m.netLiq == null ? "no snapshot" : fmtUsd(m.netLiq)}` +
    ` · 1M ${vs(one)} · 3M ${vs(three)}` +
    ` · ${act ? `${act} to review${urgent ? " (urgent)" : ""}` : "nothing to act on"}`
  );
}

// ---- building blocks ---------------------------------------------------------------

const table = (inner: string, style = "") =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;${style}">${inner}</table>`;

function sectionHead(title: string, aside = ""): string {
  return (
    `<tr><td style="padding:26px 28px 10px">` +
    table(
      `<tr><td style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.ink}">` +
        `<span style="display:inline-block;width:3px;height:11px;background:${C.brand};margin-right:8px;vertical-align:-1px"></span>${esc(title)}</td>` +
        `<td align="right" style="font-size:12px;color:${C.muted}">${aside}</td></tr>`,
    ) +
    `</td></tr>`
  );
}

const body = (html: string) => `<tr><td style="padding:0 28px">${html}</td></tr>`;

function header(m: ReportModel, img: ImageRefs): string {
  const date = m.netLiqAt
    ? new Date(m.netLiqAt).toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York",
      })
    : "No snapshot";
  const logo = img.logo
    ? `<img src="${esc(img.logo)}" width="32" height="32" alt="" style="display:block;border:0;border-radius:7px">`
    : "";
  return (
    `<tr><td style="background:${C.canvas};padding:22px 28px 24px">` +
    table(
      `<tr>` +
        `<td width="40" valign="middle">${logo}</td>` +
        `<td valign="middle" style="padding-left:${logo ? 10 : 0}px">` +
        `<div style="font-size:14px;font-weight:600;color:${C.headerText}">Risk Dashboard</div>` +
        `<div style="font-size:11px;color:${C.headerMuted}">Options &amp; Equity · Daily report</div></td>` +
        `<td align="right" valign="middle" style="font-size:12px;color:${C.headerMuted}">${esc(date)}</td>` +
        `</tr>`,
    ) +
    `<div style="padding-top:22px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${C.headerMuted}">${esc(m.portfolioName)} · Net liquidity</div>` +
    `<div style="padding-top:4px;font-size:34px;font-weight:700;color:${C.headerText};letter-spacing:-.01em">${m.netLiq == null ? "—" : esc(fmtUsd(m.netLiq))}</div>` +
    (m.dayChange == null
      ? ""
      : `<div style="padding-top:4px;font-size:13px;color:${m.dayChange >= 0 ? "#3fd3a0" : "#ff8a87"}">` +
        `${esc(signedUsd(m.dayChange))} <span style="color:${C.headerMuted}">trading P&amp;L since the last snapshot</span></div>`) +
    `</td></tr>`
  );
}

function returnTile(r: WindowReturn): string {
  const vs =
    r.excess == null
      ? `<span style="color:${C.muted}">${r.ret == null ? "history too short" : `no ${BENCHMARK} data`}</span>`
      : `<span style="display:inline-block;padding:2px 7px;border-radius:10px;font-weight:600;` +
        `color:${tone(r.excess)};background:${r.excess >= 0 ? "#e6f4ee" : "#fbeaea"}">${esc(signedPts(r.excess))} vs ${BENCHMARK}</span>`;
  return (
    `<td width="33%" valign="top" style="padding:0 4px">` +
    `<div style="border:1px solid ${C.border};border-radius:8px;padding:12px 14px;background:${C.card}">` +
    `<div style="font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:${C.muted}">${esc(r.label)}</div>` +
    `<div style="padding-top:6px;font-size:22px;font-weight:700;color:${tone(r.ret)}">${esc(signedPct(r.ret))}</div>` +
    `<div style="padding-top:2px;font-size:12px;color:${C.muted}">` +
    `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${C.bench};margin-right:5px"></span>` +
    `${BENCHMARK} ${esc(signedPct(r.benchmark))}</div>` +
    `<div style="padding-top:8px;font-size:12px">${vs}</div>` +
    `<div style="padding-top:6px;font-size:11px;color:${C.muted}">${r.tradingPnl == null ? "&nbsp;" : `${esc(signedUsd(r.tradingPnl))} trading`}</div>` +
    `</div></td>`
  );
}

function stat(label: string, value: string, color: string = C.ink): string {
  return (
    `<td width="25%" valign="top" style="padding:10px 12px;border-right:1px solid ${C.border}">` +
    `<div style="font-size:11px;color:${C.muted}">${esc(label)}</div>` +
    `<div style="padding-top:3px;font-size:15px;font-weight:600;color:${color}">${value}</div></td>`
  );
}

const th = (s: string, right = false) =>
  `<th style="text-align:${right ? "right" : "left"};padding:8px 8px;font-size:11px;font-weight:600;` +
  `letter-spacing:.03em;color:${C.muted};border-bottom:1px solid ${C.border};background:${C.panel}">${esc(s)}</th>`;
const td = (s: string, opts: { right?: boolean; color?: string; mono?: boolean; zebra?: boolean } = {}) =>
  `<td style="text-align:${opts.right ? "right" : "left"};padding:7px 8px;font-size:12.5px;border-bottom:1px solid ${C.border};` +
  `color:${opts.color ?? C.ink};${opts.zebra ? `background:${C.panel};` : ""}${opts.mono ? `font-family:${MONO};` : ""}white-space:nowrap">${s}</td>`;

// ---- the email -----------------------------------------------------------------------

export function renderHtml(m: ReportModel, img: ImageRefs = {}): string {
  const rows: string[] = [header(m, img)];

  // ---- performance vs the market -------------------------------------------------------
  rows.push(sectionHead("Performance vs the market", "time-weighted · deposits excluded"));
  rows.push(
    body(
      table(`<tr>${m.returns.map(returnTile).join("")}</tr>`) +
        (img.growth
          ? `<div style="padding-top:14px"><img src="${esc(img.growth)}" width="664" alt="Growth of $100: ${esc(m.portfolioName)} against ${BENCHMARK} total return since the first snapshot" style="display:block;width:100%;max-width:664px;height:auto;border:0"></div>` +
            `<div style="padding-top:4px;font-size:11px;color:${C.muted}">Growth of $100 since the first snapshot. ${BENCHMARK} includes dividends.` +
            `${m.drawdown != null ? ` Book is ${m.drawdown.toFixed(1)}% off its high.` : ""}</div>`
          : ""),
    ),
  );

  // ---- actions --------------------------------------------------------------------------
  const high = m.actions.filter((a) => a.priority === "high").length;
  rows.push(sectionHead("Suggested actions", m.actions.length ? `${m.actions.length} total${high ? ` · ${high} high` : ""}` : ""));
  rows.push(
    body(
      m.actions.length
        ? m.actions
            .map((a) => {
              const p = PRIORITY[a.priority];
              return (
                `<div style="border:1px solid ${C.border};border-left:3px solid ${p.fg};border-radius:6px;padding:10px 12px;margin-bottom:8px">` +
                `<div style="font-size:13.5px;font-weight:600;color:${C.ink}">` +
                `<span style="display:inline-block;font-size:10px;font-weight:700;letter-spacing:.06em;padding:2px 6px;border-radius:4px;` +
                `color:${p.fg};background:${p.bg};margin-right:8px;vertical-align:1px">${p.label}</span>${esc(a.title)}</div>` +
                `<div style="padding-top:4px;font-size:12.5px;line-height:1.5;color:${C.muted}">${esc(a.detail)}</div></div>`
              );
            })
            .join("")
        : `<div style="border:1px solid ${C.border};border-radius:6px;padding:12px;font-size:13px;color:${C.muted}">Nothing needs a decision today.</div>`,
    ),
  );

  // ---- book ------------------------------------------------------------------------------
  const b = m.book;
  rows.push(sectionHead("Book"));
  rows.push(
    body(
      `<div style="border:1px solid ${C.border};border-radius:8px;overflow:hidden">` +
        table(
          `<tr>` +
            stat("Open trades", `${b.openTrades}${b.nearestDte != null ? ` <span style="font-size:11px;font-weight:400;color:${C.muted}">next exp ${dte(b.nearestDte)}</span>` : ""}`) +
            stat("Cash", esc(fmtUsd(b.cash))) +
            stat("Buying power", esc(fmtUsd(b.buyingPower))) +
            stat("Unrealized (model)", esc(signedUsd(b.unrealizedPnl)), tone(b.unrealizedPnl)) +
            `</tr><tr style="border-top:1px solid ${C.border}">` +
            stat("Theta / day", esc(signedUsd(b.thetaPerDay)), tone(b.thetaPerDay)) +
            stat("Beta-wtd delta", esc(b.betaDelta.toFixed(0))) +
            stat("Gross exposure", esc(fmtUsd(b.grossExposure))) +
            stat(
              `VaR 95%${b.tailHorizonDays != null ? ` · ${dte(b.tailHorizonDays)}` : ""}`,
              b.var95 == null ? "—" : esc(fmtUsd(b.var95)),
              C.loss,
            ) +
            `</tr>`,
        ) +
        `</div>` +
        (b.var95 == null
          ? ""
          : `<div style="padding-top:6px;font-size:11px;color:${C.muted}">VaR and CVaR (${esc(fmtUsd(b.cvar95))}) carry the whole book to its last expiry assuming uncorrelated names; perfectly correlated, VaR is ${esc(fmtUsd(b.comonotonicVar95))}.</div>`),
    ),
  );

  // ---- risk by ticker ------------------------------------------------------------------------
  if (m.riskByTicker.length) {
    const top = m.riskByTicker.slice(0, 8);
    const scale = Math.max(100, ...top.map((r) => r.pct));
    rows.push(sectionHead("Defined risk by ticker", `% of net liquidity · flag at ${CONCENTRATION_PCT}%`));
    rows.push(
      body(
        table(
          top
            .map((r) => {
              const w = Math.max(Math.round((r.pct / scale) * 100), 1);
              const over = r.pct >= CONCENTRATION_PCT;
              return (
                `<tr>` +
                `<td width="60" style="padding:4px 8px 4px 0;font-size:12.5px;font-weight:600;font-family:${MONO};color:${C.ink}">${esc(r.ticker)}</td>` +
                `<td style="padding:4px 0">` +
                table(
                  `<tr><td width="${w}%" style="height:12px;background:${over ? C.bench : C.brand};border-radius:3px;font-size:0;line-height:0">&nbsp;</td>` +
                    `<td style="font-size:0;line-height:0">&nbsp;</td></tr>`,
                ) +
                `</td>` +
                `<td width="64" align="right" style="padding:4px 0 4px 8px;font-size:12.5px;font-weight:600;color:${over ? C.warn : C.ink}">${r.pct.toFixed(0)}%</td>` +
                `<td width="84" align="right" style="padding:4px 0 4px 8px;font-size:12px;color:${C.muted}">${esc(fmtUsd(r.maxLoss))}</td>` +
                `</tr>`
              );
            })
            .join(""),
        ) +
          `<div style="padding-top:4px;font-size:11px;color:${C.muted}">Sum of each position's defined max loss — premium paid for long options, collateral less credit for short puts.` +
          ` Amber bars are at or above the concentration flag.</div>`,
      ),
    );
  }

  // ---- open trades -----------------------------------------------------------------------------
  rows.push(sectionHead("Open trades", `${m.trades.length} positions`));
  rows.push(
    body(
      `<div style="border:1px solid ${C.border};border-radius:8px;overflow:hidden">` +
        table(
          `<tr>${th("Ticker")}${th("Position")}${th("Expiry")}${th("Qty", true)}${th("Entry", true)}${th("Mark", true)}${th("P&L", true)}</tr>` +
            m.trades
              .map((r, i) => {
                const z = i % 2 === 1;
                const badge = r.itm
                  ? ` <span style="font-size:9.5px;font-weight:700;padding:1px 5px;border-radius:3px;color:#a12a29;background:#fdecec">ITM</span>`
                  : "";
                return (
                  "<tr>" +
                  td(`<b>${esc(r.ticker)}</b>`, { mono: true, zebra: z }) +
                  td(`${esc(r.structure)} <span style="color:${C.muted}">${esc(r.strikes)}</span>${badge}`, { zebra: z }) +
                  td(r.expiration ? `${esc(r.expiration)} <span style="color:${C.muted}">${dte(r.dte)}</span>` : `<span style="color:${C.muted}">—</span>`, { zebra: z }) +
                  td(String(r.qty), { right: true, zebra: z }) +
                  td(esc(px(r.entry)), { right: true, zebra: z }) +
                  td(`${esc(px(r.mark))}${r.stale ? "*" : ""}`, { right: true, zebra: z }) +
                  td(
                    r.pnl == null
                      ? "—"
                      : `<b>${esc(signedUsd(r.pnl))}</b>${r.pnlPct == null ? "" : ` <span style="font-size:11px">${esc(signedPct(r.pnlPct, 0))}</span>`}`,
                    { right: true, color: tone(r.pnl), zebra: z },
                  ) +
                  "</tr>"
                );
              })
              .join(""),
        ) +
        `</div>` +
        `<div style="padding-top:6px;font-size:11px;color:${C.muted}">Entry and mark are per share; marks are model values. ` +
        `For short premium, P&amp;L % is the share of max profit captured.${m.trades.some((r) => r.stale) ? " * IV mark held — approximate." : ""}</div>`,
    ),
  );

  // ---- track record ---------------------------------------------------------------------------
  if (m.insights.length) {
    rows.push(sectionHead("From your track record"));
    rows.push(
      body(
        m.insights
          .map((i) => {
            const t = TONE[i.tone];
            return (
              `<div style="padding:10px 0;border-bottom:1px solid ${C.border}">` +
              `<div style="font-size:13px;font-weight:600;color:${C.ink}">` +
              `<span style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${t.fg};margin-right:8px">${t.label}</span>${esc(i.title)}</div>` +
              `<div style="padding-top:3px;font-size:12.5px;line-height:1.5;color:${C.ink}">${esc(i.body)}</div>` +
              `<div style="padding-top:3px;font-size:11px;color:${C.muted};font-family:${MONO}">${esc(i.basis)}</div></div>`
            );
          })
          .join(""),
      ),
    );
  }

  // ---- recently closed --------------------------------------------------------------------------
  rows.push(sectionHead("Closed in the last 7 days", m.closed.length ? `<b style="color:${tone(m.closedTotal)}">${esc(signedUsd(m.closedTotal))}</b>` : ""));
  rows.push(
    body(
      m.closed.length
        ? `<div style="border:1px solid ${C.border};border-radius:8px;overflow:hidden">` +
            table(
              `<tr>${th("Ticker")}${th("Position")}${th("Closed")}${th("Realized", true)}</tr>` +
                m.closed
                  .map(
                    (c, i) =>
                      "<tr>" +
                      td(`<b>${esc(c.ticker)}</b>`, { mono: true, zebra: i % 2 === 1 }) +
                      td(esc(c.structure), { zebra: i % 2 === 1 }) +
                      td(esc(c.exitDate.slice(0, 10)), { zebra: i % 2 === 1 }) +
                      td(`<b>${esc(signedUsd(c.pnl))}</b>`, { right: true, color: tone(c.pnl), zebra: i % 2 === 1 }) +
                      "</tr>",
                  )
                  .join(""),
            ) +
            `</div>`
        : `<div style="font-size:13px;color:${C.muted}">No trades closed.</div>`,
    ),
  );

  // ---- notes + footer ---------------------------------------------------------------------------
  rows.push(sectionHead("Notes"));
  rows.push(
    body(
      m.notes.map((n) => `<div style="font-size:11.5px;line-height:1.5;color:${C.muted};padding-bottom:5px">${esc(n)}</div>`).join(""),
    ),
  );
  rows.push(
    `<tr><td style="padding:22px 28px;margin-top:16px;border-top:1px solid ${C.border};font-size:11px;color:${C.muted}">` +
      `Generated ${esc(m.generatedAt.slice(0, 16).replace("T", " "))} UTC by the Risk Dashboard report job. ` +
      `Figures come from the dashboard's own engine; nothing here is a broker statement.</td></tr>`,
  );

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    // Opt out of client-side dark-mode inversion: the chart image is drawn for
    // a light surface and the header already carries the dark band.
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
    `<title>${esc(m.portfolioName)} report</title></head>` +
    `<body style="margin:0;padding:0;background:${C.page}">` +
    table(
      `<tr><td align="center" style="padding:24px 12px">` +
        table(rows.join(""), `max-width:720px;background:${C.card};border-radius:10px;overflow:hidden;font-family:${FONT};color:${C.ink}`) +
        `</td></tr>`,
      `background:${C.page}`,
    ) +
    `</body></html>`
  );
}

export function renderText(m: ReportModel): string {
  const L: string[] = [];
  L.push(`RISK DASHBOARD — ${m.portfolioName.toUpperCase()} — ${m.netLiqAt ? `snapshot ${m.netLiqAt.slice(0, 10)}` : "no snapshot"}`);
  L.push(
    `Net liquidity ${m.netLiq == null ? "—" : fmtUsd(m.netLiq)}` +
      (m.dayChange == null ? "" : ` (${signedUsd(m.dayChange)} since last snapshot)`),
  );
  L.push("", `PERFORMANCE VS ${BENCHMARK} (time-weighted, deposits excluded; ${BENCHMARK} total return)`);
  for (const r of m.returns) {
    L.push(
      `  ${r.label.padEnd(12)} book ${signedPct(r.ret).padStart(7)}   ${BENCHMARK} ${signedPct(r.benchmark).padStart(7)}   ` +
        `difference ${signedPts(r.excess)}`,
    );
  }
  const b = m.book;
  L.push(
    "",
    `${b.openTrades} open · cash ${fmtUsd(b.cash)} · buying power ${fmtUsd(b.buyingPower)} · ` +
      `unrealized ${signedUsd(b.unrealizedPnl)} · theta ${signedUsd(b.thetaPerDay)}/day` +
      (b.var95 == null ? "" : ` · VaR95 ${fmtUsd(b.var95)} to ${dte(b.tailHorizonDays)}`),
  );

  L.push("", `SUGGESTED ACTIONS (${m.actions.length})`);
  if (!m.actions.length) L.push("  Nothing needs a decision today.");
  for (const a of m.actions) {
    L.push(`  [${PRIORITY[a.priority].label}] ${a.title}`, `        ${a.detail}`);
  }

  if (m.riskByTicker.length) {
    L.push("", "DEFINED RISK BY TICKER (% of net liquidity)");
    for (const r of m.riskByTicker.slice(0, 8)) {
      L.push(`  ${r.ticker.padEnd(6)} ${`${r.pct.toFixed(0)}%`.padStart(5)}  ${fmtUsd(r.maxLoss)}`);
    }
  }

  L.push("", "OPEN TRADES");
  for (const r of m.trades) {
    L.push(
      `  ${r.ticker.padEnd(6)} ${`${r.structure} ${r.strikes}`.padEnd(30)} ` +
        `${(r.expiration ? `${r.expiration} ${dte(r.dte)}` : "").padEnd(16)} ` +
        `x${r.qty}  ${px(r.entry)} -> ${px(r.mark)}${r.stale ? "*" : ""}  ${signedUsd(r.pnl)}${r.itm ? "  ITM" : ""}`,
    );
  }

  if (m.insights.length) {
    L.push("", "FROM YOUR TRACK RECORD");
    for (const i of m.insights) L.push(`  - ${i.title}`, `    ${i.body}`, `    (${i.basis})`);
  }

  L.push("", "CLOSED IN THE LAST 7 DAYS");
  if (!m.closed.length) L.push("  No trades closed.");
  for (const c of m.closed) {
    L.push(`  ${c.ticker.padEnd(6)} ${c.structure.padEnd(22)} ${c.exitDate.slice(0, 10)}  ${signedUsd(c.pnl)}`);
  }
  if (m.closed.length) L.push(`  Total ${signedUsd(m.closedTotal)}`);

  L.push("", "NOTES");
  for (const n of m.notes) L.push(`  - ${n}`);
  return L.join("\n");
}

export function renderEmail(m: ReportModel, img: ImageRefs = {}): RenderedEmail {
  return { subject: renderSubject(m), html: renderHtml(m, img), text: renderText(m) };
}
