/**
 * Google OAuth bootstrap.
 *
 * One-time setup to populate the token vault for a user:
 *   GET /api/auth/google/start?userId=default
 *     -> redirects to Google consent screen
 *   GET /api/auth/google/callback?code=...&state=<userId>
 *     -> exchanges code for tokens, stores via GoogleClient
 */

import type { Env } from '../../worker-configuration';
import { GoogleClient } from './google-client.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/documents.readonly',
].join(' ');

function redirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/api/auth/google/callback`;
}

export async function handleOAuthStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId') ?? 'default';

  const clientId = (env as unknown as Record<string, string>).GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return Response.json({ error: 'GOOGLE_OAUTH_CLIENT_ID not configured' }, { status: 500 });
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(request),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: userId,
  });

  return Response.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
}

export async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const userId = url.searchParams.get('state') ?? 'default';

  if (!code) {
    return Response.json({ error: 'Missing authorization code' }, { status: 400 });
  }

  const clientId = (env as unknown as Record<string, string>).GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = (env as unknown as Record<string, string>).GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return Response.json({ error: 'OAuth client not configured' }, { status: 500 });
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(request),
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return Response.json({ error: 'Token exchange failed', detail: text }, { status: 502 });
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  const client = new GoogleClient({ env, userId });
  await client.storeToken({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    scopes: tokens.scope,
    expiresIn: tokens.expires_in,
  });

  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;padding:2rem;max-width:32rem">
      <h1>Connected</h1>
      <p>Google account connected for user <code>${escapeHtml(userId)}</code>.</p>
      <p>You can close this tab.</p>
    </body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
