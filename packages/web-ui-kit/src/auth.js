/**
 * web-ui-kit/auth — cookie-session + bearer auth for agent web UIs.
 *
 * Two auth modes share one `WebSessions` D1 table:
 *
 *   /app/*  — cookie session created by POST /app/login. requireWebSession()
 *             checks the cookie; on miss, redirects (mode:'page') or 401s
 *             (mode:'api').
 *
 *   /api/*  — same cookie OR `Authorization: Bearer <EXTERNAL_API_KEY>` for
 *             external apps. requireApiAuth() accepts either.
 *
 * The session id is opaque (32 random bytes hex) and persisted in D1 so it
 * survives Worker isolate cold starts. There is no rate limit by design —
 * pick a long passphrase for WEB_UI_PASSWORD or wire one in front (Cloudflare
 * Access, etc.).
 */

const COOKIE_NAME = "cos_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function nowIso() {
  return new Date().toISOString();
}

function generateSessionId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function buildSetCookie(value, { maxAgeSec, secure }) {
  const parts = [`${COOKIE_NAME}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  if (maxAgeSec != null) parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join("; ");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function createSession(env) {
  if (!env.DB) throw new Error("DB binding required for web sessions");
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO WebSessions (sessionId, createdAt, expiresAt) VALUES (?, ?, ?)`,
  ).bind(sessionId, nowIso(), expiresAt).run();
  return { sessionId, expiresAt };
}

export async function destroySession(env, sessionId) {
  if (!env.DB || !sessionId) return;
  await env.DB.prepare(`DELETE FROM WebSessions WHERE sessionId = ?`).bind(sessionId).run();
}

export async function readSessionFromRequest(request, env) {
  if (!env.DB) return null;
  const cookies = parseCookies(request.headers.get("cookie"));
  const sessionId = cookies[COOKIE_NAME];
  if (!sessionId) return null;
  const row = await env.DB.prepare(
    `SELECT sessionId, expiresAt FROM WebSessions WHERE sessionId = ?`,
  ).bind(sessionId).first();
  if (!row) return null;
  const exp = Date.parse(row.expiresAt || "");
  if (!Number.isFinite(exp) || exp < Date.now()) {
    await env.DB.prepare(`DELETE FROM WebSessions WHERE sessionId = ?`).bind(sessionId).run().catch(() => {});
    return null;
  }
  return { sessionId };
}

export function setSessionCookieHeader(sessionId, opts = { secure: true }) {
  return buildSetCookie(encodeURIComponent(sessionId), {
    maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),
    secure: opts.secure,
  });
}

export function clearSessionCookieHeader(opts = { secure: true }) {
  return buildSetCookie("", { maxAgeSec: 0, secure: opts.secure });
}

export async function requireWebSession(request, env, opts = { mode: "api" }) {
  const session = await readSessionFromRequest(request, env);
  if (session) return { ok: true, sessionId: session.sessionId, source: "session" };
  if (opts.mode === "page") {
    return {
      ok: false,
      response: Response.redirect(new URL("/app/login", request.url).toString(), 302),
    };
  }
  return { ok: false, response: jsonError("unauthorized", 401) };
}

export async function requireApiAuth(request, env) {
  const session = await readSessionFromRequest(request, env);
  if (session) return { ok: true, source: "session", sessionId: session.sessionId };

  const expected = env.EXTERNAL_API_KEY || "";
  if (expected) {
    const header = request.headers.get("authorization") || "";
    const m = header.match(/^Bearer\s+(.+)$/i);
    const token = m && m[1] ? m[1].trim() : "";
    if (token && timingSafeEqual(token, expected)) return { ok: true, source: "bearer" };
  }
  return { ok: false, response: jsonError("unauthorized", 401) };
}

export function verifyPassword(env, candidate) {
  const expected = env.WEB_UI_PASSWORD || "";
  if (!expected) return false;
  return timingSafeEqual(String(candidate ?? ""), expected);
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export const WEB_AUTH_CONST = { COOKIE_NAME, SESSION_TTL_MS };
