/**
 * Gmail REST API client backed by @agentbuilder/auth-google's D1TokenVault.
 *
 * Token bootstrap: a one-time OAuth flow stores the (cfo, user) tokens in the
 * `cfo-tokens` D1. This module reads + refreshes them but does not bootstrap.
 *
 * Two surfaces:
 *   - High-level: searchMessages(env, query) / getMessage(env, id) auto-resolve
 *     the access token and return GmailMessage records.
 *   - Helpers: getMessageBody / getHeader operate on raw GmailMessage payloads
 *     and are used directly by the vendor parsers.
 */

import { D1TokenVault, importKey, type StoredGoogleToken } from '@agentbuilder/auth-google';
import type { Env } from '../types';

const AGENT_ID = 'cfo';
const DEFAULT_USER_ID = 'default';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_SKEW_MS = 60_000;
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailMessageRef {
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
  internalDate: string;
  payload: GmailMessagePart;
}

// ── Token management ─────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function getVault(env: Env): Promise<D1TokenVault> {
  if (!env.GOOGLE_TOKEN_VAULT_KEK) {
    throw new Error('GOOGLE_TOKEN_VAULT_KEK is not configured.');
  }
  const kekBytes = base64ToBytes(env.GOOGLE_TOKEN_VAULT_KEK);
  const key = await importKey(kekBytes.buffer as ArrayBuffer);
  return new D1TokenVault({ db: env.TOKENS, encryptionKey: key });
}

async function getAccessToken(env: Env, userId: string = DEFAULT_USER_ID): Promise<string> {
  const vault = await getVault(env);
  const stored = await vault.get({ agentId: AGENT_ID, userId });
  if (!stored) {
    throw new Error(
      `No Google token for cfo:${userId}. Complete OAuth bootstrap before running email sync.`,
    );
  }
  if (stored.expiresAt - REFRESH_SKEW_MS > Date.now()) return stored.accessToken;
  if (!stored.refreshToken) {
    throw new Error('Google token expired and no refresh token available; re-authenticate.');
  }
  return refreshAccessToken(env, vault, stored);
}

async function refreshAccessToken(
  env: Env,
  vault: D1TokenVault,
  stored: StoredGoogleToken,
): Promise<string> {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set.');
  }
  const body = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken as string,
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${await res.text()}`);
  const json = await res.json() as { access_token: string; expires_in: number; scope?: string };
  const now = Date.now();
  const fresh: StoredGoogleToken = {
    agentId: AGENT_ID,
    userId: stored.userId,
    scopes: json.scope ?? stored.scopes,
    accessToken: json.access_token,
    refreshToken: stored.refreshToken,
    expiresAt: now + json.expires_in * 1000,
    createdAt: stored.createdAt,
    updatedAt: now,
  };
  await vault.put(fresh);
  return fresh.accessToken;
}

// ── Gmail API ────────────────────────────────────────────────────────────────

export async function searchMessages(env: Env, query: string, maxResults = 200): Promise<GmailMessageRef[]> {
  const accessToken = await getAccessToken(env);
  const results: GmailMessageRef[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${GMAIL_API_BASE}/messages`);
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

export async function getMessage(env: Env, messageId: string): Promise<GmailMessage> {
  const accessToken = await getAccessToken(env);
  const resp = await fetch(`${GMAIL_API_BASE}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Gmail getMessage failed: ${await resp.text()}`);
  return resp.json() as Promise<GmailMessage>;
}

// ── Message helpers (used by vendor parsers) ─────────────────────────────────

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
