/**
 * Google OAuth 2.0 authorization-code flow for the CFO worker.
 *
 * Routes:
 *   GET /oauth/google/start?user_id=<id>    → 302 to Google consent screen
 *   GET /oauth/google/callback?code&state   → exchange + vault + success page
 *
 * Both routes are public (no cookie/bearer auth) — the start URL is visited
 * from a browser, and Google calls the callback. CSRF is prevented by the
 * HMAC-signed state parameter carrying user_id.
 *
 * Required env vars (already in wrangler.toml / secrets):
 *   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
 *   GOOGLE_TOKEN_VAULT_KEK, MCP_HTTP_KEY (used as state-signing secret),
 *   TOKENS (D1 binding: cfo-tokens)
 */

import { D1TokenVault, importKey } from '@agentbuilder/auth-google';
import type { Env } from '../types';

const AGENT_ID = 'cfo';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_TTL_MS = 10 * 60 * 1000;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function handleOAuthStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  if (!userId) return text('Missing user_id query parameter.', 400);

  const cfg = config(env, url);
  if (!cfg.ok) return text(cfg.reason, 500);

  try {
    const state = await signState(cfg.stateSecret, { user_id: userId, nonce: crypto.randomUUID(), exp: Date.now() + STATE_TTL_MS });
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return Response.redirect(`${AUTHORIZE_URL}?${params}`, 302);
  } catch (err) {
    return text(`Failed to build OAuth URL: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}

export async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) return html(errorPage(`Google reported: ${oauthError}. Restart at /oauth/google/start?user_id=default`), 400);
  if (!code || !state) return html(errorPage('Missing code or state. Restart the consent flow.'), 400);

  const cfg = config(env, url);
  if (!cfg.ok) return text(cfg.reason, 500);

  let userId: string;
  try {
    const payload = await verifyState(cfg.stateSecret, state);
    userId = payload.user_id;
  } catch (err) {
    return html(errorPage(`State verification failed: ${err instanceof Error ? err.message : String(err)}`), 400);
  }

  let tokens: TokenResponse;
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0, 500)}`);
    tokens = await res.json() as TokenResponse;
  } catch (err) {
    return html(errorPage(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`), 502);
  }

  try {
    const kekBytes = base64ToBytes(env.GOOGLE_TOKEN_VAULT_KEK);
    const key = await importKey(kekBytes.buffer as ArrayBuffer);
    const vault = new D1TokenVault({ db: env.TOKENS, encryptionKey: key });
    const now = Date.now();
    const scopes = (tokens.scope ?? SCOPES.join(' ')).split(/\s+/).filter(Boolean).sort().join(' ');
    await vault.put({
      agentId: AGENT_ID, userId, scopes,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: now + tokens.expires_in * 1000,
      createdAt: now, updatedAt: now,
    });
  } catch (err) {
    return html(errorPage(`Vault write failed: ${err instanceof Error ? err.message : String(err)}`), 500);
  }

  return html(successPage(userId, tokens.refresh_token != null));
}

// ── Config ───────────────────────────────────────────────────────────────────

type ConfigResult =
  | { ok: true; clientId: string; clientSecret: string; redirectUri: string; stateSecret: string }
  | { ok: false; reason: string };

function config(env: Env, requestUrl: URL): ConfigResult {
  if (!env.GOOGLE_OAUTH_CLIENT_ID) return { ok: false, reason: 'GOOGLE_OAUTH_CLIENT_ID is not set.' };
  if (!env.GOOGLE_OAUTH_CLIENT_SECRET) return { ok: false, reason: 'GOOGLE_OAUTH_CLIENT_SECRET is not set.' };
  if (!env.MCP_HTTP_KEY) return { ok: false, reason: 'MCP_HTTP_KEY must be set (used as state-signing secret).' };
  if (!env.GOOGLE_TOKEN_VAULT_KEK) return { ok: false, reason: 'GOOGLE_TOKEN_VAULT_KEK is not set.' };
  return {
    ok: true,
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: `${requestUrl.origin}/oauth/google/callback`,
    stateSecret: env.MCP_HTTP_KEY,
  };
}

// ── State signing (HMAC-SHA256) ───────────────────────────────────────────────

interface OAuthState { user_id: string; nonce: string; exp: number }

async function signState(secret: string, payload: OAuthState): Promise<string> {
  const b64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(secret, b64);
  return `${b64}.${sig}`;
}

async function verifyState(secret: string, token: string): Promise<OAuthState> {
  const dot = token.indexOf('.');
  if (dot < 0) throw new Error('Invalid state: no signature');
  const b64 = token.slice(0, dot);
  const expected = await hmac(secret, b64);
  if (!timingSafeEq(token.slice(dot + 1), expected)) throw new Error('Invalid state: signature mismatch');
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(b64))) as OAuthState;
  if (!payload.user_id || !payload.nonce || typeof payload.exp !== 'number') throw new Error('Invalid state: malformed payload');
  if (Date.now() > payload.exp) throw new Error('Invalid state: expired — restart the OAuth flow.');
  return payload;
}

async function hmac(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return b64urlEncode(new Uint8Array(sig));
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ── Responses ─────────────────────────────────────────────────────────────────

interface TokenResponse { access_token: string; refresh_token?: string; expires_in: number; scope: string }

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function successPage(userId: string, gotRefreshToken: boolean): string {
  const refreshNote = gotRefreshToken
    ? '<p>A refresh token was stored — access will persist without re-consent.</p>'
    : '<p><strong>Warning:</strong> no refresh token was issued. If access expires, revisit /oauth/google/start?user_id=default to re-consent.</p>';
  return wrap('Google access granted', `
    <h1>Google access granted</h1>
    <p>Tokens for <code>${esc(userId)}</code> stored in the CFO vault.</p>
    <p>Scopes granted:</p>
    <ul>${SCOPES.map(s => `<li><code>${esc(s)}</code></li>`).join('')}</ul>
    ${refreshNote}
    <p>You can close this tab. Gmail sync and Google Sheets reporting will now work.</p>
  `);
}

function errorPage(message: string): string {
  return wrap('OAuth error', `
    <h1>OAuth error</h1>
    <p>${esc(message)}</p>
    <p>Ensure <code>/oauth/google/callback</code> is registered as an authorized redirect URI in the Google Cloud OAuth client.</p>
  `);
}

function wrap(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.4rem}code{background:#f3f3f3;padding:0 .3em;border-radius:3px}ul{padding-left:1.25rem}</style>
</head><body>${body}</body></html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
