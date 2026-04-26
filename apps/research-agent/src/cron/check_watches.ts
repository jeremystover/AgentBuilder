/**
 * Page-monitoring cron: fetch each due watch, evaluate the match condition,
 * record hits, and send notification email via the SEND_EMAIL binding.
 *
 * Runs from the `*\/5 * * * *` trigger. Each watch's own interval_minutes
 * gates whether it's actually due on any given run.
 */

import type { Env } from "../types";
import { watchQueries, watchHitQueries } from "../lib/db";
import type { WatchRow } from "../lib/db";

const FETCH_HEADERS: HeadersInit = {
  "User-Agent": "Mozilla/5.0 (compatible; ResearchAgentWatcher/1.0)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

const FETCH_TIMEOUT_MS  = 15_000;
const MAX_BYTES         = 3_000_000;
const MAX_PER_RUN       = 20;
const SNIPPET_CHARS     = 240;

async function fetchPageText(url: string): Promise<{ text: string; hash: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: FETCH_HEADERS, signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const buf = await response.arrayBuffer();
    const bytes = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
    const html = new TextDecoder().decode(bytes);
    const text = stripHtml(html);
    const hash = await sha256(text);
    return { text, hash };
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface MatchResult {
  matched: boolean;
  snippet: string | null;
}

function evaluateMatch(watch: WatchRow, text: string, newHash: string): MatchResult {
  switch (watch.match_type) {
    case "contains": {
      const needle = (watch.match_value ?? "").toLowerCase();
      const idx = text.toLowerCase().indexOf(needle);
      if (idx < 0) return { matched: false, snippet: null };
      const start = Math.max(0, idx - 60);
      const end   = Math.min(text.length, idx + needle.length + 180);
      return { matched: true, snippet: text.slice(start, end) };
    }
    case "not_contains": {
      const needle = (watch.match_value ?? "").toLowerCase();
      const present = text.toLowerCase().includes(needle);
      return { matched: !present, snippet: present ? null : `(text "${watch.match_value}" not found on page)` };
    }
    case "regex": {
      try {
        const re = new RegExp(watch.match_value ?? "", "i");
        const m = re.exec(text);
        if (!m) return { matched: false, snippet: null };
        const start = Math.max(0, (m.index ?? 0) - 60);
        const end   = Math.min(text.length, (m.index ?? 0) + m[0].length + 180);
        return { matched: true, snippet: text.slice(start, end) };
      } catch {
        return { matched: false, snippet: null };
      }
    }
    case "hash": {
      if (!watch.last_hash) return { matched: false, snippet: null };
      if (watch.last_hash === newHash) return { matched: false, snippet: null };
      return { matched: true, snippet: "(page content changed)" };
    }
  }
}

/** Build text + HTML email bodies for a notification. */
function buildEmailBodies(watch: WatchRow, snippet: string | null): { text: string; html: string; subject: string } {
  const subject = `[Watch] ${watch.name} — match on ${new URL(watch.url).hostname}`;
  const snippetBlock = snippet ? `\n\nSnippet:\n${snippet.slice(0, SNIPPET_CHARS)}\n` : "";
  const text = `Your watch "${watch.name}" matched.

URL: ${watch.url}
Match type: ${watch.match_type}${watch.match_value ? `\nMatch value: ${watch.match_value}` : ""}${snippetBlock}
Detected at: ${new Date().toISOString()}

Manage watches via the research-agent manage_watches MCP tool.
`;
  const snippetHtml = snippet
    ? `<p><strong>Snippet:</strong><br><pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(snippet.slice(0, SNIPPET_CHARS))}</pre></p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">
<h2 style="margin:0 0 .5em">Watch matched: ${escapeHtml(watch.name)}</h2>
<p><a href="${escapeAttr(watch.url)}">${escapeHtml(watch.url)}</a></p>
<p><strong>Match:</strong> ${escapeHtml(watch.match_type)}${watch.match_value ? ` — <code>${escapeHtml(watch.match_value)}</code>` : ""}</p>
${snippetHtml}
<p style="color:#666;font-size:.9em">Detected at ${new Date().toISOString()}</p>
</body></html>`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string { return escapeHtml(s); }

/** Build RFC 822 MIME message and send via SEND_EMAIL binding. */
async function sendNotification(env: Env, watch: WatchRow, snippet: string | null): Promise<void> {
  if (!env.SEND_EMAIL) {
    console.warn("[cron/check_watches] SEND_EMAIL binding missing; skipping notify for", watch.id);
    return;
  }
  const from = env.WATCH_NOTIFY_FROM;
  if (!from) {
    console.warn("[cron/check_watches] WATCH_NOTIFY_FROM not set; skipping notify for", watch.id);
    return;
  }

  const { subject, text, html } = buildEmailBodies(watch, snippet);
  const boundary = `=_rb_${crypto.randomUUID().replace(/-/g, "")}`;
  const mime =
    `From: ${from}\r\n` +
    `To: ${watch.notify_email}\r\n` +
    `Subject: ${subject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/alternative; boundary="${boundary}"\r\n` +
    `Message-ID: <${crypto.randomUUID()}@research-agent>\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    `${text}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=utf-8\r\n\r\n` +
    `${html}\r\n` +
    `--${boundary}--\r\n`;

  const { EmailMessage } = await import("cloudflare:email");
  const msg = new EmailMessage(from, watch.notify_email, mime);
  await env.SEND_EMAIL.send(msg);
}

/** Should we actually send a notification? Respects notify_mode. */
function shouldNotify(watch: WatchRow, matched: boolean): boolean {
  if (!matched) return false;
  if (watch.notify_mode === "every") return true;
  // once mode: notify if never notified, or if the match state has reset
  // (last_matched_at is null or last_notified_at is null).
  if (!watch.last_notified_at) return true;
  // In "once" mode, suppress if already notified since the last time the match
  // condition reset. Reset means last_matched_at is older than last_notified_at
  // — i.e. we've seen a non-match since the last notification.
  if (!watch.last_matched_at) return true;
  if (watch.last_matched_at < watch.last_notified_at) return true;
  return false;
}

async function processWatch(env: Env, watch: WatchRow): Promise<void> {
  try {
    const { text, hash } = await fetchPageText(watch.url);
    const { matched, snippet } = evaluateMatch(watch, text, hash);

    const willNotify = shouldNotify(watch, matched);

    if (matched) {
      await watchHitQueries.insert(env.CONTENT_DB, {
        watch_id:  watch.id,
        snippet:   snippet?.slice(0, 500) ?? null,
        page_hash: hash,
        notified:  willNotify,
      });
    }

    if (willNotify) {
      try {
        await sendNotification(env, watch, snippet);
      } catch (e) {
        console.error(`[cron/check_watches] notify failed for ${watch.id}:`, e);
      }
    }

    await watchQueries.recordCheck(env.CONTENT_DB, watch.id, {
      hash,
      matched,
      notified: willNotify,
      error:    null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[cron/check_watches] fetch failed ${watch.url}:`, message);
    await watchQueries.recordCheck(env.CONTENT_DB, watch.id, {
      hash: null, matched: false, notified: false, error: message.slice(0, 500),
    });
  }
}

export async function runCheckWatches(env: Env, _ctx: ExecutionContext): Promise<void> {
  const due = await watchQueries.listDue(env.CONTENT_DB, new Date().toISOString());
  if (due.length === 0) return;
  console.log(`[cron/check_watches] processing ${due.length} watch(es)`);
  const batch = due.slice(0, MAX_PER_RUN);
  await Promise.all(batch.map((w) => processWatch(env, w)));
}
