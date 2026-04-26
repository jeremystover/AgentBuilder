/**
 * Inbound email handler.
 *
 * Two ingestion modes:
 *
 *   1. Newsletter mode — when the sender's address matches an entry in
 *      NEWSLETTER_SENDERS, the email body itself is the article. The body
 *      is parsed out of the MIME envelope and posted to the ingest pipeline
 *      with `content` so no URL fetch is performed (paywalled URLs would
 *      otherwise return a teaser).
 *
 *   2. URL-extraction mode (default) — for forwarded emails that aren't
 *      newsletters, harvest URLs from the subject + body and ingest each.
 *
 * NEWSLETTER_SENDERS is a JSON-encoded map keyed by lowercase address:
 *   {
 *     "newsletter@charterworks.com": { "provider": "charter", "sourceId": "..." },
 *     "hello@stratechery.com":       { "provider": "stratechery" }
 *   }
 */

import type { Env } from "../types";
import { ingestUrl } from "../mcp/tools/ingest_url";
import { decodeHeader, parseAddress, parseMime } from "./mime";

const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gi;

interface NewsletterConfig {
  provider: string;
  sourceId?: string;
}

type NewsletterMap = Record<string, NewsletterConfig>;

function parseNewsletterMap(raw: string | undefined): NewsletterMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: NewsletterMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const cfg = v as Record<string, unknown>;
      if (typeof cfg["provider"] !== "string") continue;
      out[k.toLowerCase()] = {
        provider: cfg["provider"],
        sourceId: typeof cfg["sourceId"] === "string" ? cfg["sourceId"] : undefined,
      };
    }
    return out;
  } catch (e) {
    console.warn("[email/handler] NEWSLETTER_SENDERS parse failed:", e);
    return {};
  }
}

async function readRaw(message: ForwardableEmailMessage): Promise<string> {
  const reader = message.raw.getReader();
  const chunks: Uint8Array[] = [];
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    if (value) chunks.push(value);
    done = d;
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const full = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    full.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(full);
}

/** Pull the "View in browser" link from the email body so downstream readers
 *  have a clickable canonical URL. Falls back to null. */
function findCanonicalUrl(html: string | null, text: string): string | null {
  const haystack = html ?? text;
  // Prefer explicit "view in browser" / "read online" CTAs.
  const labelled = /(view (?:in|on) (?:browser|web|online)|read (?:in|on) (?:browser|web|online))[\s\S]{0,200}?(https?:\/\/[^\s"')<>]+)/i.exec(haystack);
  if (labelled?.[2]) return labelled[2];
  const first = URL_RE.exec(haystack);
  return first?.[0] ?? null;
}

function syntheticUrl(provider: string, messageId: string | null, fallback: string): string {
  const id = (messageId ?? fallback).replace(/[<>]/g, "").replace(/[^a-z0-9._-]/gi, "-").slice(0, 120);
  return `https://newsletters.research-agent.local/${provider}/${id}`;
}

async function ingestNewsletter(
  message: ForwardableEmailMessage,
  raw: string,
  config: NewsletterConfig,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const mime = parseMime(raw);
  if (!mime.textBody.trim()) {
    console.warn(`[email/handler] newsletter body empty from=${message.from}`);
    return;
  }

  const subjectRaw = message.headers.get("subject") ?? "(untitled)";
  const subject = decodeHeader(subjectRaw);
  const fromHeader = message.headers.get("from") ?? message.from;
  const { name: fromName } = parseAddress(fromHeader);
  const messageId = message.headers.get("message-id");
  const dateHeader = message.headers.get("date");
  const publishedAt = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

  const canonical = findCanonicalUrl(mime.htmlBody, mime.textBody);
  const url = canonical ?? syntheticUrl(config.provider, messageId, message.from);

  await ingestUrl(
    {
      url,
      content: mime.textBody,
      title: subject,
      author: fromName ?? message.from,
      published_at: publishedAt,
      source_id: config.sourceId,
      note: `Newsletter (${config.provider}) from ${message.from}`,
      force_reingest: false,
    },
    env,
    ctx,
  );
  console.log(`[email/handler] newsletter ingested provider=${config.provider} url=${url}`);
}

async function ingestForwardedUrls(
  message: ForwardableEmailMessage,
  raw: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const subject = message.headers.get("subject") ?? "";
  const combined = `${subject}\n${raw}`;
  const urls = [...new Set(combined.match(URL_RE) ?? [])];
  if (urls.length === 0) {
    console.log(`[email/handler] no URLs found from=${message.from}`);
    return;
  }
  console.log(`[email/handler] found ${urls.length} URL(s) from=${message.from}`);
  for (const url of urls.slice(0, 10)) {
    try {
      await ingestUrl(
        { url, note: `From email: ${message.from} — ${subject}`, force_reingest: false },
        env,
        ctx,
      );
      console.log(`[email/handler] ingested ${url}`);
    } catch (e) {
      console.warn(`[email/handler] ingest failed for ${url}:`, e);
    }
  }
}

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  let raw = "";
  try {
    raw = await readRaw(message);
  } catch (e) {
    console.warn("[email/handler] could not read body:", e);
    return;
  }

  const newsletters = parseNewsletterMap(env.NEWSLETTER_SENDERS);
  const config = newsletters[message.from.toLowerCase()];

  if (config) {
    try {
      await ingestNewsletter(message, raw, config, env, ctx);
      return;
    } catch (e) {
      console.error(`[email/handler] newsletter ingest failed from=${message.from}:`, e);
      // Fall through to URL extraction so we still get something useful.
    }
  }

  await ingestForwardedUrls(message, raw, env, ctx);
}
