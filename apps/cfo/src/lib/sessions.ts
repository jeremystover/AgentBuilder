/**
 * Postgres-backed session helpers — drop-in for the parts of
 * @agentbuilder/web-ui-kit/auth that this worker uses. The kit hardwires
 * env.DB (D1) for its WebSessions table; we keep state in Postgres
 * (web_sessions table from migrations/0001_initial.sql) instead.
 *
 * Cookie format and TTL match the kit so a future move back to D1
 * sessions wouldn't invalidate any in-flight cookies.
 */

import type { Env } from '../types';
import { db } from './db';

const COOKIE_NAME = 'cfo_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function buildSetCookie(value: string, opts: { maxAgeSec: number; secure: boolean }): string {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) parts.push('Secure');
  parts.push(`Max-Age=${opts.maxAgeSec}`);
  return parts.join('; ');
}

export async function createSession(env: Env): Promise<{ sessionId: string; expiresAt: string }> {
  const sql = db(env);
  try {
    const sessionId = generateSessionId();
    const userId = env.WEB_UI_USER_ID ?? 'default';
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await sql`
      INSERT INTO web_sessions (id, user_id, expires_at)
      VALUES (${sessionId}, ${userId}, ${expiresAt})
    `;
    return { sessionId, expiresAt };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function destroySession(env: Env, sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  const sql = db(env);
  try {
    await sql`DELETE FROM web_sessions WHERE id = ${sessionId}`;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function readSessionFromRequest(request: Request, env: Env): Promise<{ sessionId: string } | null> {
  const sessionId = parseCookies(request.headers.get('cookie'))[COOKIE_NAME];
  if (!sessionId) return null;
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string; expires_at: string }>>`
      SELECT id, expires_at FROM web_sessions WHERE id = ${sessionId} LIMIT 1
    `;
    if (rows.length === 0) return null;
    const exp = Date.parse(rows[0]!.expires_at);
    if (!Number.isFinite(exp) || exp < Date.now()) {
      await sql`DELETE FROM web_sessions WHERE id = ${sessionId}`.catch(() => {});
      return null;
    }
    return { sessionId };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export function setSessionCookieHeader(sessionId: string, opts: { secure: boolean }): string {
  return buildSetCookie(encodeURIComponent(sessionId), {
    maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),
    secure: opts.secure,
  });
}

export function clearSessionCookieHeader(opts: { secure: boolean }): string {
  return buildSetCookie('', { maxAgeSec: 0, secure: opts.secure });
}

export type AuthOk = { ok: true; sessionId?: string; source: 'session' | 'bearer' };
export type AuthFail = { ok: false; response: Response };
export type AuthResult = AuthOk | AuthFail;

export async function requireWebSession(
  request: Request,
  env: Env,
  opts: { mode: 'page' | 'api'; loginPath?: string } = { mode: 'api' },
): Promise<AuthResult> {
  const session = await readSessionFromRequest(request, env);
  if (session) return { ok: true, sessionId: session.sessionId, source: 'session' };
  if (opts.mode === 'page') {
    const loginPath = opts.loginPath ?? '/login';
    return { ok: false, response: Response.redirect(new URL(loginPath, request.url).toString(), 302) };
  }
  return { ok: false, response: jsonError('unauthorized', 401) };
}

export async function requireApiAuth(request: Request, env: Env): Promise<AuthResult> {
  const session = await readSessionFromRequest(request, env);
  if (session) return { ok: true, source: 'session', sessionId: session.sessionId };
  const expected = env.EXTERNAL_API_KEY ?? '';
  if (expected) {
    const header = request.headers.get('authorization') ?? '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    const token = m?.[1]?.trim() ?? '';
    if (token && timingSafeEqual(token, expected)) return { ok: true, source: 'bearer' };
  }
  return { ok: false, response: jsonError('unauthorized', 401) };
}

export function verifyPassword(env: Env, candidate: unknown): boolean {
  const expected = env.WEB_UI_PASSWORD ?? '';
  if (!expected) return false;
  return timingSafeEqual(String(candidate ?? ''), expected);
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function loginHtml(opts: { error?: string } = {}): string {
  const error = opts.error
    ? `<p style="color:#DC2626;font-size:14px;margin:0 0 12px">${opts.error}</p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Finances</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:#F8FAFC; color:#0F172A; display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; }
    form { background:#FFF; border:1px solid #E2E8F0; border-radius:12px; padding:32px; width:320px; }
    h1 { font-size:18px; margin:0 0 16px; }
    input { display:block; width:100%; box-sizing:border-box; padding:8px 12px; font-size:14px; border:1px solid #E2E8F0; border-radius:8px; margin-bottom:12px; }
    button { width:100%; padding:8px 12px; background:#4F46E5; color:#FFF; border:0; border-radius:8px; font-weight:500; cursor:pointer; }
  </style></head><body>
  <form method="POST" action="/login">
    <h1>Finances</h1>
    ${error}
    <input type="password" name="password" placeholder="Password" autofocus required>
    <button type="submit">Sign in</button>
  </form></body></html>`;
}
