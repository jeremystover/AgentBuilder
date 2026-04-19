/**
 * Canva Connect OAuth2 — authorization_code + refresh_token flow.
 *
 * Routes:
 *   GET /api/auth/canva/start?userId=default
 *     -> redirects to Canva consent screen
 *   GET /api/auth/canva/callback?code=...&state=<userId>
 *     -> exchanges code for tokens, stores in canva_tokens
 *
 * Canva Connect docs:
 *   Auth URL: https://www.canva.com/api/oauth/authorize
 *   Token URL: https://api.canva.com/rest/v1/oauth/token
 *   Scopes: asset:write folder:write design:content:read design:content:write
 *
 * Tokens are stored in D1 (unencrypted — Canva tokens only grant access to
 * Canva assets, not Google data). If we want encryption later we can reuse
 * the vault pattern.
 */

import { AgentError } from '@agentbuilder/core';
import type { Env } from '../../worker-configuration';

const CANVA_AUTH_URL = 'https://www.canva.com/api/oauth/authorize';
const CANVA_TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token';
const REFRESH_SKEW_MS = 60_000;

const SCOPES = [
  'asset:write',
  'folder:write',
  'design:content:read',
  'design:content:write',
].join(' ');

function redirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/api/auth/canva/callback`;
}

export async function handleCanvaOAuthStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId') ?? 'default';

  if (!env.CANVA_CLIENT_ID) {
    return Response.json({ error: 'CANVA_CLIENT_ID not configured' }, { status: 500 });
  }

  // Canva requires a code_challenge for PKCE (S256). Generate and store in
  // a short-lived query param via state. For simplicity in a single-user
  // setup we use a fixed verifier per session and pass it through state.
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeS256Challenge(codeVerifier);

  // Encode both userId and verifier in state (pipe-separated, base64).
  const state = btoa(`${userId}|${codeVerifier}`);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.CANVA_CLIENT_ID,
    redirect_uri: redirectUri(request),
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return Response.redirect(`${CANVA_AUTH_URL}?${params.toString()}`, 302);
}

export async function handleCanvaOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state') ?? '';

  if (!code) {
    const error = url.searchParams.get('error') ?? 'unknown';
    const desc = url.searchParams.get('error_description') ?? '';
    return Response.json(
      { error: 'Canva auth failed', detail: `${error}: ${desc}` },
      { status: 400 },
    );
  }

  let userId = 'default';
  let codeVerifier = '';
  try {
    const decoded = atob(stateRaw);
    const parts = decoded.split('|');
    userId = parts[0] ?? 'default';
    codeVerifier = parts[1] ?? '';
  } catch {
    return Response.json({ error: 'Invalid state parameter' }, { status: 400 });
  }

  if (!env.CANVA_CLIENT_ID || !env.CANVA_CLIENT_SECRET) {
    return Response.json({ error: 'Canva OAuth client not configured' }, { status: 500 });
  }

  // Exchange code for tokens. Canva uses HTTP Basic auth for client creds.
  const basicAuth = btoa(`${env.CANVA_CLIENT_ID}:${env.CANVA_CLIENT_SECRET}`);
  const tokenRes = await fetch(CANVA_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basicAuth}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(request),
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return Response.json(
      { error: 'Canva token exchange failed', detail: text },
      { status: 502 },
    );
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO canva_tokens (user_id, access_token, refresh_token, expires_at, scopes, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(user_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       scopes = excluded.scopes,
       updated_at = excluded.updated_at`,
  )
    .bind(
      userId,
      tokens.access_token,
      tokens.refresh_token,
      now + tokens.expires_in * 1000,
      tokens.scope ?? SCOPES,
      now,
    )
    .run();

  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;padding:2rem;max-width:32rem">
      <h1>Canva Connected</h1>
      <p>Canva account connected for user <code>${escapeHtml(userId)}</code>.</p>
      <p>You can close this tab.</p>
    </body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

// ── Token access for tools ─────────────────────────────────────────────────

export async function getCanvaAccessToken(env: Env, userId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM canva_tokens WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<{ access_token: string; refresh_token: string; expires_at: number }>();

  if (!row) {
    throw new AgentError(
      `No Canva token for user "${userId}". Complete OAuth at /api/auth/canva/start first.`,
      { code: 'unauthorized' },
    );
  }

  if (row.expires_at - REFRESH_SKEW_MS > Date.now()) {
    return row.access_token;
  }

  return refreshCanvaToken(env, userId, row.refresh_token);
}

async function refreshCanvaToken(env: Env, userId: string, refreshToken: string): Promise<string> {
  if (!env.CANVA_CLIENT_ID || !env.CANVA_CLIENT_SECRET) {
    throw new AgentError('CANVA_CLIENT_ID / CANVA_CLIENT_SECRET not set.', { code: 'internal' });
  }

  const basicAuth = btoa(`${env.CANVA_CLIENT_ID}:${env.CANVA_CLIENT_SECRET}`);
  const res = await fetch(CANVA_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basicAuth}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AgentError(`Canva token refresh failed: ${text}`, { code: 'upstream_failure' });
  }

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE canva_tokens
        SET access_token = ?1,
            refresh_token = ?2,
            expires_at = ?3,
            updated_at = ?4
      WHERE user_id = ?5`,
  )
    .bind(
      tokens.access_token,
      tokens.refresh_token ?? refreshToken,
      now + tokens.expires_in * 1000,
      now,
      userId,
    )
    .run();

  return tokens.access_token;
}

// ── PKCE helpers ───────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncode(bytes);
}

async function computeS256Challenge(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
