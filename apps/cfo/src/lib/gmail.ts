/**
 * Gmail REST API client for the CFO worker.
 *
 * Uses the fleet-wide Google OAuth credentials:
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN
 *
 * These are the same secrets the chief-of-staff uses. The refresh token is
 * obtained once via scripts/google-auth.js in the chief-of-staff app and
 * stored as a Cloudflare secret — no in-app OAuth flow needed.
 */

import type { Env } from '../types';

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface GmailMessagePart {
  mimeType: string;
  body: { data?: string; size: number };
  parts?: GmailMessagePart[];
  headers?: Array<{ name: string; value: string }>;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string; // epoch millis as string
  payload: GmailMessagePart;
}

// Exchange a refresh token for a short-lived access token.
export async function refreshAccessToken(env: Env, refreshToken: string): Promise<string> {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) throw new Error(`Gmail token refresh failed: ${await resp.text()}`);
  const data = await resp.json() as { access_token: string };
  return data.access_token;
}

// Convenience: get an access token using the env-stored personal refresh token.
// Throws if GOOGLE_OAUTH_REFRESH_TOKEN is not configured.
export async function getEnvAccessToken(env: Env): Promise<string> {
  if (!env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error(
      'GOOGLE_OAUTH_REFRESH_TOKEN is not set. Run: wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN',
    );
  }
  return refreshAccessToken(env, env.GOOGLE_OAUTH_REFRESH_TOKEN);
}

export async function searchMessages(
  accessToken: string,
  query: string,
  maxResults = 200,
): Promise<GmailMessageRef[]> {
  const results: GmailMessageRef[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(Math.min(maxResults - results.length, 100)));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) throw new Error(`Gmail search failed: ${await resp.text()}`);
    const data = await resp.json() as { messages?: GmailMessageRef[]; nextPageToken?: string };

    results.push(...(data.messages ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken && results.length < maxResults);

  return results;
}

export async function getMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) throw new Error(`Gmail getMessage failed: ${await resp.text()}`);
  return resp.json() as Promise<GmailMessage>;
}

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '=='.slice(0, (4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function extractPart(part: GmailMessagePart, mimeType: string): string | null {
  if (part.mimeType === mimeType && part.body.data) return decodeBase64Url(part.body.data);
  if (part.parts) {
    for (const sub of part.parts) {
      const found = extractPart(sub, mimeType);
      if (found) return found;
    }
  }
  return null;
}

export function getMessageBody(message: GmailMessage): { text: string; html: string } {
  return {
    html: extractPart(message.payload, 'text/html') ?? '',
    text: extractPart(message.payload, 'text/plain') ?? '',
  };
}

export function getHeader(message: GmailMessage, name: string): string {
  return message.payload.headers
    ?.find(h => h.name.toLowerCase() === name.toLowerCase())
    ?.value ?? '';
}
