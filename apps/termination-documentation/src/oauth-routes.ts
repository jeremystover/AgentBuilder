/**
 * HTTP handlers for the Google OAuth consent flow.
 *
 * Routes (mounted in index.ts):
 *   GET /oauth/google/start?user_id=<id>    → 302 to Google consent
 *   GET /oauth/google/callback?code&state   → exchange + vault + success page
 *
 * No MCP bearer auth on these routes — Google calls the callback, and the
 * start page is invoked from a user's browser. CSRF/tampering is prevented
 * by the signed `state` token carrying the user_id.
 *
 * Required secrets (see wrangler.toml):
 *   GOOGLE_OAUTH_CLIENT_ID       — Google Cloud OAuth 2.0 client id
 *   GOOGLE_OAUTH_CLIENT_SECRET   — Google Cloud OAuth 2.0 client secret
 *   GOOGLE_TOKEN_VAULT_KEK       — base64 AES-256 KEK for the shared vault
 *   DB (D1 binding)              — shared agentbuilder-core database
 *   OAUTH_STATE_SECRET           — state-signing secret (falls back to MCP_HTTP_KEY)
 */

import { D1TokenVault, importKey } from '@agentbuilder/auth-google';
import type { Env } from '../worker-configuration';
import {
  buildAuthUrl,
  exchangeCode,
  SCOPES,
  verifyState,
  type OAuthConfig,
} from './lib/google/oauth.js';

const AGENT_ID = 'termination-documentation';

export async function handleOAuthStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  if (!userId) return textResponse('Missing user_id query parameter.', 400);

  const cfg = oauthConfig(env, url);
  if (!cfg.ok) return textResponse(cfg.reason, 500);

  try {
    const authUrl = await buildAuthUrl(cfg.config, userId);
    return Response.redirect(authUrl, 302);
  } catch (err) {
    return textResponse(
      `Failed to build OAuth URL: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
}

export async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return htmlResponse(
      errorPage(`Google reported: ${oauthError}. Restart at /oauth/google/start?user_id=...`),
      400,
    );
  }
  if (!code || !state) {
    return htmlResponse(errorPage('Missing code or state. Restart the consent flow.'), 400);
  }

  const cfg = oauthConfig(env, url);
  if (!cfg.ok) return textResponse(cfg.reason, 500);

  // Verify state and pull user_id out of it.
  let userId: string;
  try {
    const payload = await verifyState(cfg.config.stateSecret, state);
    userId = payload.user_id;
  } catch (err) {
    return htmlResponse(
      errorPage(`State verification failed: ${err instanceof Error ? err.message : String(err)}`),
      400,
    );
  }

  // Exchange the auth code for tokens.
  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(cfg.config, code);
  } catch (err) {
    return htmlResponse(
      errorPage(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`),
      502,
    );
  }

  // Persist to the vault.
  if (!env.DB) {
    return textResponse(
      'Vault unavailable: D1 binding (DB) is not configured on this Worker. Uncomment [[d1_databases]] in wrangler.toml.',
      500,
    );
  }
  if (!env.GOOGLE_TOKEN_VAULT_KEK) {
    return textResponse(
      'Vault unavailable: GOOGLE_TOKEN_VAULT_KEK secret is not set.',
      500,
    );
  }

  try {
    const kekBuffer = base64ToArrayBuffer(env.GOOGLE_TOKEN_VAULT_KEK);
    const kek = await importKey(kekBuffer);
    const vault = new D1TokenVault({ db: env.DB, encryptionKey: kek });

    const now = Date.now();
    const scopesSorted = (tokens.scope ?? SCOPES.join(' '))
      .split(/\s+/)
      .filter(Boolean)
      .sort()
      .join(' ');

    await vault.put({
      agentId: AGENT_ID,
      userId,
      scopes: scopesSorted,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: now + tokens.expires_in * 1000,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    return htmlResponse(
      errorPage(`Vault write failed: ${err instanceof Error ? err.message : String(err)}`),
      500,
    );
  }

  return htmlResponse(successPage(userId, tokens.refresh_token != null));
}

// ── Config helper ───────────────────────────────────────────────────────────

type ConfigResult =
  | { ok: true; config: OAuthConfig }
  | { ok: false; reason: string };

function oauthConfig(env: Env, requestUrl: URL): ConfigResult {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const stateSecret = env.OAUTH_STATE_SECRET ?? env.MCP_HTTP_KEY;

  if (!clientId) return { ok: false, reason: 'GOOGLE_OAUTH_CLIENT_ID secret is not set.' };
  if (!clientSecret)
    return { ok: false, reason: 'GOOGLE_OAUTH_CLIENT_SECRET secret is not set.' };
  if (!stateSecret)
    return {
      ok: false,
      reason:
        'OAUTH_STATE_SECRET (or MCP_HTTP_KEY as fallback) must be set to sign the state parameter.',
    };

  const redirectUri = `${requestUrl.origin}/oauth/google/callback`;
  return { ok: true, config: { clientId, clientSecret, redirectUri, stateSecret } };
}

// ── Response helpers ────────────────────────────────────────────────────────

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function successPage(userId: string, gotRefreshToken: boolean): string {
  const refreshNote = gotRefreshToken
    ? '<p>A refresh token was stored, so access will persist without re-consent.</p>'
    : '<p><strong>Warning:</strong> no refresh token was issued. If access expires, re-run the start URL to re-consent.</p>';
  return wrapHtml(
    'Google access granted',
    `
      <h1>Google access granted</h1>
      <p>Tokens for user <code>${escapeHtml(userId)}</code> were stored in the termination-documentation vault.</p>
      <p>Scopes granted:</p>
      <ul>${SCOPES.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join('')}</ul>
      ${refreshNote}
      <p>You can close this tab and return to Claude.ai. The agent will now be able to create your Drive case folder and write the evidence memo to Google Docs.</p>
    `,
  );
}

function errorPage(message: string): string {
  return wrapHtml(
    'OAuth error',
    `
      <h1>OAuth error</h1>
      <p>${escapeHtml(message)}</p>
      <p>If this keeps happening, confirm the Google OAuth client has <code>/oauth/google/callback</code> registered as an authorized redirect URI.</p>
    `,
  );
}

function wrapHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; }
  code { background: #f3f3f3; padding: 0 0.3em; border-radius: 3px; }
  ul { padding-left: 1.25rem; }
</style>
</head><body>${body}</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
