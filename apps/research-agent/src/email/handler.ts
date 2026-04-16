/**
 * Email ingestion handler.
 * Receives forwarded emails, extracts URLs from subject + body, ingests each.
 */

import type { Env } from "../types";
import { ingestUrl } from "../mcp/tools/ingest_url";

const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gi;

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env:     Env,
  ctx:     ExecutionContext,
): Promise<void> {
  const subject = message.headers.get("subject") ?? "";
  const from    = message.from;

  // Read raw email body
  let bodyText = "";
  try {
    const reader = message.raw.getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      if (value) chunks.push(value);
      done = d;
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const full  = new Uint8Array(total);
    let offset  = 0;
    for (const chunk of chunks) { full.set(chunk, offset); offset += chunk.length; }
    bodyText = new TextDecoder().decode(full);
  } catch (e) {
    console.warn("[email/handler] could not read body:", e);
  }

  const combined = `${subject}\n${bodyText}`;
  const urls     = [...new Set(combined.match(URL_RE) ?? [])];

  if (urls.length === 0) {
    console.log(`[email/handler] no URLs found from=${from}`);
    return;
  }

  console.log(`[email/handler] found ${urls.length} URL(s) from=${from}`);

  for (const url of urls.slice(0, 10)) {
    try {
      await ingestUrl({ url, note: `From email: ${from} — ${subject}`, force_reingest: false }, env, ctx);
      console.log(`[email/handler] ingested ${url}`);
    } catch (e) {
      console.warn(`[email/handler] ingest failed for ${url}:`, e);
    }
  }
}
