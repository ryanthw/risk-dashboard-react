/**
 * Render a ReportModel as an email: subject, HTML body, plain-text fallback.
 *
 * Inline styles and tables only — email clients strip <style> blocks and most
 * layout CSS unevenly, and a report that renders as a wall of text in one
 * client is a report that stops being read. The plain-text part carries the
 * same content for clients that show it.
 */
import { fmtUsd } from "@/lib/format";
import type { ActionPriority } from "@/engine/actions";
import type { InsightTone } from "@/engine/insights";
import type { ReportModel, WindowReturn } from "./portfolioReport";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const signedPct = (x: number | null, digits = 1) =>
  x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;
const signedUsd = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${fmtUsd(x)}`);
const px = (x: number | null) => (x == null ? "—" : `$${x.toFixed(2)}`);
const dte = (d: number | null) => (d == null ? "" : `${Math.max(Math.floor(d), 0)}d`);

const C = {
  text: "#1f2328",
  muted: "#656d76",
  border: "#d8dee4",
  panel: "#f6f8fa",
  gain: "#1a7f37",
  loss: "#cf222e",
  warn: "#9a6700",
};
const tone = (x: number | null) => (x == null ? C.muted : x >= 0 ? C.gain : C.loss);

const PRIORITY: Record<ActionPriority, { label: string; color: string }> = {
  high: { label: "HIGH", color: C.loss },
  medium: { label: "MED", color: C.warn },
  low: { label: "LOW", color: C.muted },
};
const TONE: Record<InsightTone, string> = {
  negative: C.loss,
  unknown: C.warn,
  positive: C.gain,
  neutral: C.muted,
};

export function renderSubject(m: ReportModel): string {
  const r = (l: string) => m.returns.find((x) => x.label === l)?.ret ?? null;
  const act = m.actions.filter((a) => a.priority !== "low").length;
  const urgent = m.actions.some((a) => a.priority === "high");
  return (
    `[${m.portfolioName}] ${m.netLiq == null ? "no snapshot" : fmtUsd(m.netLiq)}` +
    ` · 1M ${signedPct(r("1M"))} · 3M ${signedPct(r("3M"))}` +
    ` · ${act ? `${act} to review${urgent ? " (urgent)" : ""}` : "nothing to act on"}`
  );
}

function section(title: string, body: string): string {
  return (
    `<tr><td style="padding:20px 0 6px;font-size:12px;font-weight:600;letter-spacing:.06em;` +
    `text-transform:uppercase;color:${C.muted}">${esc(title)}</td></tr>` +
    `<tr><td>${body}</td></tr>`
  );
}

function tile(label: string, value: string, sub = "", color = C.text): string {
  return (
    `<td style="padding:10px 12px;background:${C.panel};border:1px solid ${C.border};vertical-align:top">` +
    `<div style="font-size:11px;color:${C.muted}">${esc(label)}</div>` +
    `<div style="font-size:18px;font-weight:600;color:${color};padding-top:2px">${esc(value)}</div>` +
    (sub ? `<div style="font-size:11px;color:${C.muted};padding-top:2px">${esc(sub)}</div>` : "") +
    `</td>`
  );
}

function returnTile(r: WindowReturn): string {
  return tile(
    `${r.label} return (TWR)`,
    signedPct(r.ret),
    r.ret == null ? "history too short" : `${signedUsd(r.tradingPnl)} trading`,
    tone(r.ret),
  );
}

const th = (s: string, right = false) =>
  `<th style="text-align:${right ? "right" : "left"};padding:6px 8px;font-size:11px;font-weight:600;color:${C.muted};border-bottom:1px solid ${C.border}">${esc(s)}</th>`;
const td = (s: string, opts: { right?: boolean; color?: string; mono?: boolean } = {}) =>
  `<td style="text-align:${opts.right ? "right" : "left"};padding:6px 8px;font-size:13px;border-bottom:1px solid ${C.border};` +
  `color:${opts.color ?? C.text}${opts.mono ? ";font-family:Consolas,Menlo,monospace" : ""}">${s}</td>`;

function table(head: string, rows: string[]): string {
  return (
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">` +
    `${head ? `<tr>${head}</tr>` : ""}${rows.join("")}</table>`
  );
}

export function renderHtml(m: ReportModel): string {
  const parts: string[] = [];

  // ---- headline -----------------------------------------------------------------
  parts.push(
    `<tr><td style="padding-bottom:4px;font-size:20px;font-weight:600">${esc(m.portfolioName)}</td></tr>` +
      `<tr><td style="font-size:12px;color:${C.muted}">` +
      `${m.netLiqAt ? `Snapshot ${esc(m.netLiqAt.slice(0, 10))}` : "No snapshot"} · generated ${esc(m.generatedAt.slice(0, 16).replace("T", " "))} UTC` +
      `</td></tr>`,
  );
  parts.push(
    `<tr><td style="padding-top:14px">` +
      `<table role="presentation" width="100%" cellspacing="6" cellpadding="0"><tr>` +
      tile("Net liquidity", m.netLiq == null ? "—" : fmtUsd(m.netLiq), m.dayChange == null ? "" : `${signedUsd(m.dayChange)} since last snapshot`) +
      m.returns.map(returnTile).join("") +
      `</tr></table></td></tr>`,
  );

  // ---- book -----------------------------------------------------------------------
  const b = m.book;
  parts.push(
    section(
      "Book",
      table(
        "",
        [
          ["Open trades", `${b.openTrades}${b.nearestDte != null ? ` · nearest expiry ${dte(b.nearestDte)}` : ""}`],
          ["Cash · buying power", `${fmtUsd(b.cash)} · ${fmtUsd(b.buyingPower)}`],
          ["Unrealized P&L (model)", `<span style="color:${tone(b.unrealizedPnl)}">${signedUsd(b.unrealizedPnl)}</span>`],
          ["Theta / day", `<span style="color:${tone(b.thetaPerDay)}">${signedUsd(b.thetaPerDay)}</span>`],
          ["Beta-weighted delta", b.betaDelta.toFixed(0)],
          ["Gross exposure (sum of max loss)", fmtUsd(b.grossExposure)],
          [
            "VaR 95% / CVaR 95%",
            b.var95 == null
              ? "no option legs"
              : `${fmtUsd(b.var95)} / ${fmtUsd(b.cvar95)} to ${dte(b.tailHorizonDays)} · correlated ${fmtUsd(b.comonotonicVar95)}`,
          ],
          ["Drawdown from high", m.drawdown == null ? "—" : `${m.drawdown.toFixed(1)}%`],
        ].map(([k, v]) => `<tr>${td(esc(k), { color: C.muted })}${td(v, { right: true })}</tr>`),
      ),
    ),
  );

  // ---- actions --------------------------------------------------------------------
  parts.push(
    section(
      `Suggested actions (${m.actions.length})`,
      m.actions.length
        ? m.actions
            .map(
              (a) =>
                `<div style="padding:8px 10px;margin-bottom:6px;border:1px solid ${C.border};border-left:3px solid ${PRIORITY[a.priority].color}">` +
                `<div style="font-size:13px;font-weight:600"><span style="font-size:10px;color:${PRIORITY[a.priority].color};padding-right:6px">${PRIORITY[a.priority].label}</span>${esc(a.title)}</div>` +
                `<div style="font-size:12px;color:${C.muted};padding-top:3px">${esc(a.detail)}</div></div>`,
            )
            .join("")
        : `<div style="font-size:13px;color:${C.muted}">Nothing needs a decision today.</div>`,
    ),
  );

  // ---- open trades ---------------------------------------------------------------
  parts.push(
    section(
      "Open trades",
      table(
        th("Ticker") + th("Position") + th("Exp") + th("Qty", true) + th("Entry", true) + th("Mark", true) + th("P&L", true) + th("Spot", true),
        m.trades.map(
          (r) =>
            "<tr>" +
            td(`<b>${esc(r.ticker)}</b>`, { mono: true }) +
            td(`${esc(r.structure)} ${esc(r.strikes)}${r.itm ? ` <span style="color:${C.loss};font-size:11px">ITM</span>` : ""}`) +
            td(r.expiration ? `${esc(r.expiration)} <span style="color:${C.muted}">${dte(r.dte)}</span>` : "—") +
            td(String(r.qty), { right: true }) +
            td(px(r.entry), { right: true }) +
            td(`${px(r.mark)}${r.stale ? "*" : ""}`, { right: true }) +
            td(
              r.pnl == null ? "—" : `${signedUsd(r.pnl)}${r.pnlPct == null ? "" : ` <span style="font-size:11px">${signedPct(r.pnlPct, 0)}</span>`}`,
              { right: true, color: tone(r.pnl) },
            ) +
            td(px(r.underlying), { right: true }) +
            "</tr>",
        ),
      ) +
        `<div style="font-size:11px;color:${C.muted};padding-top:4px">Entry and mark are per share. ` +
        `For short premium, P&L % is the share of max profit captured.${m.trades.some((r) => r.stale) ? " * IV mark held." : ""}</div>`,
    ),
  );

  // ---- track record ---------------------------------------------------------------
  if (m.insights.length) {
    parts.push(
      section(
        "From your track record",
        m.insights
          .map(
            (i) =>
              `<div style="padding:6px 0;border-bottom:1px solid ${C.border}">` +
              `<div style="font-size:13px;font-weight:600;color:${TONE[i.tone]}">${esc(i.title)}</div>` +
              `<div style="font-size:12px;color:${C.text};padding-top:2px">${esc(i.body)}</div>` +
              `<div style="font-size:11px;color:${C.muted};padding-top:2px;font-family:Consolas,Menlo,monospace">${esc(i.basis)}</div></div>`,
          )
          .join(""),
      ),
    );
  }

  // ---- recently closed --------------------------------------------------------------
  parts.push(
    section(
      "Closed in the last 7 days",
      m.closed.length
        ? table(
            th("Ticker") + th("Position") + th("Closed") + th("Realized", true),
            [
              ...m.closed.map(
                (c) =>
                  "<tr>" +
                  td(`<b>${esc(c.ticker)}</b>`, { mono: true }) +
                  td(esc(c.structure)) +
                  td(esc(c.exitDate.slice(0, 10))) +
                  td(signedUsd(c.pnl), { right: true, color: tone(c.pnl) }) +
                  "</tr>",
              ),
              `<tr>${td("<b>Total</b>")}${td("")}${td("")}${td(`<b>${signedUsd(m.closedTotal)}</b>`, { right: true, color: tone(m.closedTotal) })}</tr>`,
            ],
          )
        : `<div style="font-size:13px;color:${C.muted}">No trades closed.</div>`,
    ),
  );

  // ---- notes --------------------------------------------------------------------------
  parts.push(
    section(
      "Notes",
      m.notes.map((n) => `<div style="font-size:11px;color:${C.muted};padding-bottom:4px">${esc(n)}</div>`).join(""),
    ),
  );

  return (
    `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:16px">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:760px;` +
    `font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${C.text}">` +
    parts.join("") +
    `</table></td></tr></table></body></html>`
  );
}

export function renderText(m: ReportModel): string {
  const L: string[] = [];
  L.push(`${m.portfolioName.toUpperCase()} — ${m.netLiqAt ? `snapshot ${m.netLiqAt.slice(0, 10)}` : "no snapshot"}`);
  L.push(
    `Net liquidity ${m.netLiq == null ? "—" : fmtUsd(m.netLiq)}` +
      (m.dayChange == null ? "" : ` (${signedUsd(m.dayChange)} since last snapshot)`),
  );
  L.push(m.returns.map((r) => `${r.label} ${signedPct(r.ret)}`).join("   ") + "   (time-weighted, deposits excluded)");
  const b = m.book;
  L.push(
    `${b.openTrades} open · cash ${fmtUsd(b.cash)} · buying power ${fmtUsd(b.buyingPower)} · ` +
      `unrealized ${signedUsd(b.unrealizedPnl)} · theta ${signedUsd(b.thetaPerDay)}/day` +
      (b.var95 == null ? "" : ` · VaR95 ${fmtUsd(b.var95)} to ${dte(b.tailHorizonDays)}`),
  );

  L.push("", `SUGGESTED ACTIONS (${m.actions.length})`);
  if (!m.actions.length) L.push("  Nothing needs a decision today.");
  for (const a of m.actions) {
    L.push(`  [${PRIORITY[a.priority].label}] ${a.title}`, `        ${a.detail}`);
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

export function renderEmail(m: ReportModel): RenderedEmail {
  return { subject: renderSubject(m), html: renderHtml(m), text: renderText(m) };
}
