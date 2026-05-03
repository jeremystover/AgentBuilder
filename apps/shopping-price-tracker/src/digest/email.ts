/**
 * Send a rendered digest as one MIME message per recipient via SEND_EMAIL.
 *
 * Pattern lifted from research-agent/src/cron/check_watches.ts (the
 * EmailMessage + multipart/alternative MIME body construction). Subject
 * is prefixed [Shopping] so users can route it separately from the
 * Research Agent's [Watch] mail.
 */

import type { Env } from "../types";
import type { RenderedDigest } from "./render";

export interface SendDigestResult {
  attempted: number;
  sent: number;
  failed: number;
  error?: string;
}

export async function sendDigestEmail(
  env: Env,
  rendered: RenderedDigest,
  recipients: string[],
): Promise<SendDigestResult> {
  const result: SendDigestResult = { attempted: recipients.length, sent: 0, failed: 0 };

  if (recipients.length === 0) {
    result.error = "no recipients configured";
    return result;
  }
  if (!env.SEND_EMAIL) {
    result.error = "SEND_EMAIL binding missing";
    return result;
  }
  const from = env.DIGEST_FROM;
  if (!from) {
    result.error = "DIGEST_FROM not set";
    return result;
  }

  const { EmailMessage } = await import("cloudflare:email");

  for (const to of recipients) {
    try {
      const mime = buildMime(from, to, rendered);
      const msg = new EmailMessage(from, to, mime);
      await env.SEND_EMAIL.send(msg);
      result.sent++;
    } catch (e) {
      result.failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[digest/email] send failed for ${to}:`, msg);
      if (!result.error) result.error = msg;
    }
  }

  return result;
}

function buildMime(from: string, to: string, r: RenderedDigest): string {
  const boundary = `=_spt_${crypto.randomUUID().replace(/-/g, "")}`;
  return (
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${r.subject}\r\n` +
    "MIME-Version: 1.0\r\n" +
    `Content-Type: multipart/alternative; boundary="${boundary}"\r\n` +
    `Message-ID: <${crypto.randomUUID()}@shopping-price-tracker>\r\n` +
    "\r\n" +
    `--${boundary}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
    `${r.text}\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: text/html; charset=utf-8\r\n\r\n" +
    `${r.html}\r\n` +
    `--${boundary}--\r\n`
  );
}
