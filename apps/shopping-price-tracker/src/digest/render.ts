/**
 * Render a built digest to plain text + HTML email bodies. Pure function;
 * no IO. The HTML body has an inline sparkline (SVG) per entry — we don't
 * pull in Chart.js for email since most clients block scripts.
 */

import { formatCents } from "../lib/money";
import type { BuiltDigest, DigestEntry } from "./build";

export interface RenderedDigest {
  subject: string;
  text: string;
  html: string;
}

export function renderDigest(digest: BuiltDigest): RenderedDigest {
  const { ranAt, entries, winnersParagraph } = digest;
  const date = ranAt.slice(0, 10);

  const tagPriority: Record<string, number> = {
    "hit-target": 0,
    drop: 1,
    sale: 2,
    "above-max": 3,
    "no-change": 4,
  };
  const sorted = [...entries].sort((a, b) => {
    const ta = Math.min(...a.tags.map((t) => tagPriority[t] ?? 5));
    const tb = Math.min(...b.tags.map((t) => tagPriority[t] ?? 5));
    if (ta !== tb) return ta - tb;
    return (a.bestToday?.price_cents ?? Infinity) - (b.bestToday?.price_cents ?? Infinity);
  });

  const products = sorted.filter((e) => e.item.kind === "product");
  const flights = sorted.filter((e) => e.item.kind === "flight");

  const subject = `[Shopping] Daily price digest — ${date} (${entries.length} item${entries.length === 1 ? "" : "s"})`;

  const text = renderText(winnersParagraph, products, flights, ranAt);
  const html = renderHtml(winnersParagraph, products, flights, ranAt);
  return { subject, text, html };
}

// ── Plain text ─────────────────────────────────────────────────────────────────

function renderText(opener: string, products: DigestEntry[], flights: DigestEntry[], ranAt: string): string {
  const out: string[] = [];
  out.push("Shopping Price Tracker — daily digest");
  out.push(`Run: ${ranAt}`);
  out.push("");
  if (opener) {
    out.push(opener);
    out.push("");
  }
  if (products.length > 0) {
    out.push("PRODUCTS");
    out.push("--------");
    for (const e of products) out.push(formatEntryText(e));
    out.push("");
  }
  if (flights.length > 0) {
    out.push("FLIGHTS");
    out.push("-------");
    for (const e of flights) out.push(formatEntryText(e));
    out.push("");
  }
  out.push("Manage at https://shopping-price-tracker.<acct>.workers.dev/app");
  return out.join("\n");
}

function formatEntryText(e: DigestEntry): string {
  const lines: string[] = [];
  const tagline = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
  const subtitle =
    e.item.kind === "flight" && e.flight
      ? `${e.flight.origin}→${e.flight.destination} ${e.flight.depart_start}..${e.flight.depart_end}`
      : e.item.model_number || "";
  lines.push(`• ${e.item.title}${subtitle ? ` (${subtitle})` : ""}${tagline}`);
  if (e.bestToday) {
    const at = e.bestToday.listing_url ? `\n  ${e.bestToday.listing_url}` : "";
    lines.push(
      `  best today: ${formatCents(e.bestToday.price_cents, e.bestToday.currency)} via ${e.bestToday.source}${at}`,
    );
  } else {
    lines.push("  no listings found today");
  }
  if (e.item.target_price_cents !== null) {
    lines.push(`  target: ${formatCents(e.item.target_price_cents, e.item.currency)}`);
  }
  if (e.rolling14Median) {
    lines.push(`  14d median: ${formatCents(e.rolling14Median, e.item.currency)}`);
  }
  if (e.oneLiner) {
    lines.push(`  ${e.oneLiner}`);
  }
  return lines.join("\n");
}

// ── HTML ───────────────────────────────────────────────────────────────────────

function renderHtml(opener: string, products: DigestEntry[], flights: DigestEntry[], ranAt: string): string {
  const sections: string[] = [];
  if (products.length > 0) sections.push(renderSection("Products", products));
  if (flights.length > 0) sections.push(renderSection("Flights", flights));

  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#1f2433;max-width:680px;margin:0 auto;padding:24px">
  <h1 style="margin:0 0 4px;font-size:22px;font-family:Georgia,serif;font-weight:600">Shopping price digest</h1>
  <p style="color:#6b7280;font-size:13px;margin:0 0 18px">${escapeHtml(ranAt)}</p>
  ${opener ? `<p style="background:#fbfaf6;border:1px solid #e7e5d8;border-radius:10px;padding:12px 14px;margin:0 0 18px">${escapeHtml(opener)}</p>` : ""}
  ${sections.join("\n")}
  <p style="font-size:12px;color:#9ca3af;margin-top:28px">Manage tracked items in the dashboard.</p>
</body></html>`;
}

function renderSection(title: string, entries: DigestEntry[]): string {
  return `<h2 style="font-family:Georgia,serif;font-size:17px;margin:18px 0 10px;border-bottom:1px solid #e7e5d8;padding-bottom:6px">${escapeHtml(title)}</h2>
${entries.map(renderEntryHtml).join("\n")}`;
}

function renderEntryHtml(e: DigestEntry): string {
  const chips = e.tags.map(renderTag).join(" ");
  const target =
    e.item.target_price_cents !== null
      ? `<span style="color:#6b7280">target ${escapeHtml(formatCents(e.item.target_price_cents, e.item.currency))}</span>`
      : "";
  const median =
    e.rolling14Median !== null
      ? `<span style="color:#6b7280">14d median ${escapeHtml(formatCents(e.rolling14Median, e.item.currency))}</span>`
      : "";

  const subtitle =
    e.item.kind === "flight" && e.flight
      ? `<div style="font-size:13px;color:#6b7280;margin-top:2px">${escapeHtml(e.flight.origin)}→${escapeHtml(e.flight.destination)} · ${escapeHtml(e.flight.depart_start)} – ${escapeHtml(e.flight.depart_end)}${e.flight.return_start ? ` · return ${escapeHtml(e.flight.return_start)} – ${escapeHtml(e.flight.return_end ?? "")}` : ""}</div>`
      : e.item.model_number
        ? `<div style="font-size:13px;color:#6b7280;margin-top:2px">${escapeHtml(e.item.model_number)}</div>`
        : "";

  const priceBlock = e.bestToday
    ? `<div style="font-size:18px;font-weight:600;color:#1f2433">${escapeHtml(formatCents(e.bestToday.price_cents, e.bestToday.currency))}</div>
       <div style="font-size:13px"><a href="${escapeAttr(e.bestToday.listing_url)}" style="color:#3730a3;text-decoration:none">${escapeHtml(e.bestToday.source)}</a></div>`
    : `<div style="color:#9ca3af;font-size:14px">no listings today</div>`;

  const callout = e.tags.includes("hit-target")
    ? `<div style="margin-top:8px;padding:8px 10px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;color:#065f46;font-size:13px;font-weight:500">Ready to buy — under your target.</div>`
    : "";

  const sparkline = renderSparklineSvg(e.sparkline);

  return `<div style="display:flex;gap:16px;align-items:flex-start;padding:14px 0;border-bottom:1px solid #f1efe6">
  <div style="flex:1 1 auto;min-width:0">
    <div style="font-weight:600;font-size:15px">${escapeHtml(e.item.title)}</div>
    ${subtitle}
    <div style="margin-top:6px">${chips}</div>
    ${e.oneLiner ? `<div style="margin-top:6px;color:#374151;font-size:14px">${escapeHtml(e.oneLiner)}</div>` : ""}
    <div style="margin-top:6px;font-size:12px">${target} ${median}</div>
    ${callout}
  </div>
  <div style="flex:0 0 140px;text-align:right">
    ${priceBlock}
    <div style="margin-top:6px">${sparkline}</div>
  </div>
</div>`;
}

function renderTag(tag: string): string {
  const styles: Record<string, string> = {
    "hit-target": "background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0",
    drop: "background:#eff6ff;color:#1e3a8a;border:1px solid #bfdbfe",
    sale: "background:#fef3c7;color:#92400e;border:1px solid #fde68a",
    "above-max": "background:#fef2f2;color:#991b1b;border:1px solid #fecaca",
    "no-change": "background:#f3f4f6;color:#4b5563;border:1px solid #e5e7eb",
  };
  const style = styles[tag] ?? styles["no-change"]!;
  return `<span style="${style};border-radius:999px;padding:2px 8px;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(tag)}</span>`;
}

function renderSparklineSvg(values: number[]): string {
  const filtered = values.filter((v) => v > 0);
  if (filtered.length < 2) return "";
  const w = 140;
  const h = 28;
  const min = Math.min(...filtered);
  const max = Math.max(...filtered);
  const range = max - min || 1;
  const step = w / Math.max(1, values.length - 1);
  const points = values
    .map((v, i) => {
      if (v <= 0) return null;
      const x = i * step;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter((p): p is string => p !== null)
    .join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:inline-block">
    <polyline fill="none" stroke="#3730a3" stroke-width="1.5" points="${points}"/>
  </svg>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
