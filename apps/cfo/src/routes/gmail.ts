import type { Env } from '../types';
import { jsonError, jsonOk, getUserId } from '../types';
import { exchangeCodeForTokens } from '../lib/gmail';
import { syncAmazonEmailsForUser } from '../lib/nightly-amazon-sync';

// ── OAuth ─────────────────────────────────────────────────────────────────────

// GET /gmail/oauth/start
// Redirects the logged-in user to Google's consent screen.
// Encodes user_id + a random nonce in the `state` param so the callback
// can identify the user without relying on cookies.
export async function handleGmailOAuthStart(request: Request, env: Env): Promise<Response> {
  if (!env.GMAIL_CLIENT_ID) return jsonError('GMAIL_CLIENT_ID is not configured', 500);

  const url = new URL(request.url);
  const userId = getUserId(request);
  const state = btoa(JSON.stringify({ userId, nonce: crypto.randomUUID() }));
  const redirectUri = `${url.protocol}//${url.host}/gmail/oauth/callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GMAIL_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.readonly');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent'); // always return a refresh_token
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

// GET /gmail/oauth/callback
// Google redirects here after the user approves. Exchanges the code for tokens
// and upserts the gmail_enrollments row.
export async function handleGmailOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) return jsonError(`Google OAuth error: ${error}`, 400);

  const code = url.searchParams.get('code');
  if (!code) return jsonError('Missing authorization code', 400);

  // Decode user_id from state; fall back to default for direct nav.
  let userId = 'default';
  try {
    const decoded = JSON.parse(atob(url.searchParams.get('state') ?? '')) as { userId?: string };
    if (decoded.userId) userId = decoded.userId;
  } catch { /* ignore */ }

  const redirectUri = `${url.protocol}//${url.host}/gmail/oauth/callback`;

  let tokens: { access_token: string; refresh_token: string; email: string };
  try {
    tokens = await exchangeCodeForTokens(env, code, redirectUri);
  } catch (err) {
    return jsonError(`Token exchange failed: ${String(err)}`, 502);
  }

  await env.DB.prepare(
    `INSERT INTO gmail_enrollments (id, user_id, email_address, refresh_token, access_token)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       email_address  = excluded.email_address,
       refresh_token  = excluded.refresh_token,
       access_token   = excluded.access_token,
       last_synced_at = NULL`,
  ).bind(crypto.randomUUID(), userId, tokens.email, tokens.refresh_token, tokens.access_token).run();

  return new Response(
    `<!doctype html><html><body style="font-family:sans-serif;padding:2rem">
      <h2>Gmail connected</h2>
      <p>Account: <strong>${tokens.email}</strong></p>
      <p>Amazon order emails will now be synced automatically each night.</p>
      <p><a href="/">Back to CFO</a></p>
    </body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

// ── Status + manual sync ──────────────────────────────────────────────────────

// GET /gmail/status
export async function handleGmailStatus(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const row = await env.DB.prepare(
    `SELECT email_address, last_synced_at, created_at FROM gmail_enrollments WHERE user_id = ?`,
  ).bind(userId).first<{ email_address: string | null; last_synced_at: string | null; created_at: string }>();

  return jsonOk({
    connected: !!row,
    email_address: row?.email_address ?? null,
    last_synced_at: row?.last_synced_at ?? null,
    connected_at: row?.created_at ?? null,
  });
}

// POST /gmail/sync  — manual trigger for the nightly email sync
export async function handleGmailSync(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const enrollment = await env.DB.prepare(
    `SELECT id, user_id, refresh_token, last_synced_at FROM gmail_enrollments WHERE user_id = ?`,
  ).bind(userId).first<{ id: string; user_id: string; refresh_token: string; last_synced_at: string | null }>();

  if (!enrollment) {
    return jsonError(
      'Gmail not connected. Visit /gmail/oauth/start (while logged in) to link your account.',
      404,
    );
  }

  const result = await syncAmazonEmailsForUser(env, enrollment);
  return jsonOk(result);
}

// DELETE /gmail/disconnect
export async function handleGmailDisconnect(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  await env.DB.prepare(`DELETE FROM gmail_enrollments WHERE user_id = ?`).bind(userId).run();
  return jsonOk({ message: 'Gmail disconnected. Nightly Amazon email sync is now disabled.' });
}
