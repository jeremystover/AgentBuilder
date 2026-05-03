/**
 * /dashboard — fleet monitoring web UI.
 *
 * Routes:
 *   GET  /dashboard            → SPA shell (cookie-gated)
 *   GET  /dashboard/login      → password form
 *   POST /dashboard/login      → verify password + set session cookie
 *   GET  /dashboard/logout     → destroy session
 *   GET  /dashboard/api/*      → JSON endpoints (cookie OR bearer auth)
 *
 * Auth uses @agentbuilder/web-ui-kit (WebSessions table in DB).
 */

import {
  clearSessionCookieHeader,
  createSession,
  destroySession,
  requireApiAuth,
  requireWebSession,
  setSessionCookieHeader,
  verifyPassword,
} from '@agentbuilder/web-ui-kit';
import type { Env } from '../../worker-configuration';
import { handleDashboardApi } from './api';
import { dashboardPage, loginPage } from './html';

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function handleDashboard(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith('/dashboard')) return null;

  // ── /dashboard/login ────────────────────────────────────────────────────
  if (path === '/dashboard/login') {
    if (request.method === 'GET') return htmlResponse(loginPage());
    if (request.method === 'POST') {
      if (!env.WEB_UI_PASSWORD) {
        return htmlResponse(
          loginPage({ error: 'WEB_UI_PASSWORD is not configured on this worker.' }),
          500,
        );
      }
      const form = await request.formData().catch(() => null);
      const pass = form?.get('password') ?? '';
      if (!verifyPassword(env, pass)) {
        return htmlResponse(loginPage({ error: 'Wrong password.' }), 401);
      }
      const { sessionId } = await createSession(env);
      const secure = url.protocol === 'https:';
      return new Response(null, {
        status: 302,
        headers: {
          location: '/dashboard',
          'set-cookie': setSessionCookieHeader(sessionId, { secure }),
        },
      });
    }
    return new Response('method not allowed', { status: 405 });
  }

  // ── /dashboard/logout ───────────────────────────────────────────────────
  if (path === '/dashboard/logout') {
    const session = await requireWebSession(request, env, {
      mode: 'page',
      loginPath: '/dashboard/login',
    });
    if (session.ok) await destroySession(env, session.sessionId);
    const secure = url.protocol === 'https:';
    return new Response(null, {
      status: 302,
      headers: {
        location: '/dashboard/login',
        'set-cookie': clearSessionCookieHeader({ secure }),
      },
    });
  }

  // ── /dashboard/api/* — bearer or cookie ─────────────────────────────────
  if (path.startsWith('/dashboard/api/')) {
    const auth = await requireApiAuth(request, env);
    if (!auth.ok) return auth.response;
    return handleDashboardApi(request, env, url);
  }

  // ── /dashboard or /dashboard/* — cookie-gated SPA shell ─────────────────
  if (path === '/dashboard' || path.startsWith('/dashboard/')) {
    const auth = await requireWebSession(request, env, {
      mode: 'page',
      loginPath: '/dashboard/login',
    });
    if (!auth.ok) return auth.response;
    return htmlResponse(dashboardPage());
  }

  return jsonResponse({ error: 'not found' }, 404);
}
