/**
 * Twilio client + inbound signature verification.
 *
 * Outbound: POST application/x-www-form-urlencoded to
 *   https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
 * with HTTP Basic auth (account SID : auth token).
 *
 * Inbound: Twilio signs every webhook request with X-Twilio-Signature.
 * The signature is base64(HMAC-SHA1(authToken, fullUrl + sortedFormParams)).
 * We MUST verify this — without it /sms/inbound is an open spam endpoint.
 *
 * Phase A keeps this dependency-free (no twilio SDK). Cloudflare Workers
 * have Web Crypto for HMAC-SHA1 and fetch for the API call, so the
 * surface stays small and bundle-friendly.
 */

import type { Env } from '../types';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string; // Twilio phone number in E.164, e.g. +14155551234
}

export function getTwilioConfig(env: Env): TwilioConfig | null {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
    return null;
  }
  return {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_FROM,
  };
}

export interface SendSmsResult {
  sid: string;
  status: string;
}

export async function sendSms(
  cfg: TwilioConfig,
  to: string,
  body: string,
): Promise<SendSmsResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`;
  const form = new URLSearchParams({ From: cfg.from, To: to, Body: body });
  const auth = btoa(`${cfg.accountSid}:${cfg.authToken}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Twilio send failed ${res.status}: ${errBody.slice(0, 500)}`);
  }
  const data = (await res.json()) as { sid?: string; status?: string };
  return { sid: data.sid ?? '', status: data.status ?? '' };
}

// ── Inbound signature verification ─────────────────────────────────────────
// Twilio's algorithm (https://www.twilio.com/docs/usage/security):
//   1. Take the full URL, including the query string (no fragment)
//   2. Sort the application/x-www-form-urlencoded POST params alphabetically
//   3. Append each param's name immediately followed by its value (no
//      separators) to the URL string
//   4. HMAC-SHA1 the result with the auth token, base64-encode
//   5. Compare to the X-Twilio-Signature header (constant-time)

export interface VerifySignatureInput {
  authToken: string;
  /** Full URL Twilio called, including https:// scheme and query string. */
  url: string;
  /** Form-encoded POST params parsed as a plain object. */
  params: Record<string, string>;
  /** Value of the X-Twilio-Signature header. */
  signatureHeader: string;
}

export async function verifyTwilioSignature(input: VerifySignatureInput): Promise<boolean> {
  const sortedKeys = Object.keys(input.params).sort();
  let payload = input.url;
  for (const k of sortedKeys) payload += k + input.params[k];

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(input.authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  // base64 encode (Cloudflare Workers don't have Buffer)
  let bin = '';
  for (let i = 0; i < sigBytes.length; i++) bin += String.fromCharCode(sigBytes[i]!);
  const computed = btoa(bin);
  return constantTimeEquals(computed, input.signatureHeader);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── TwiML helpers ──────────────────────────────────────────────────────────
// Inbound responses use TwiML so we can reply in the same HTTP turn.

export function twimlMessage(body: string): Response {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

export function twimlEmpty(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}
