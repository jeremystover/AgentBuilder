/**
 * Skill: platform-api-integration
 *
 * Thin auth + request wrappers for platform APIs. Every outbound
 * platform call goes through here so rate-limit handling, caching
 * (via env.CACHE), and secret rotation stay in one place.
 *
 * Status: stub — Guesty Lite does not offer an API, so listing import
 * uses manual entry for all platforms. This file is reserved for future
 * platform integrations (e.g. Guesty Pro API, VRBO iCal polling).
 */
import type { Env } from '../../worker-configuration';

/**
 * Guesty REST API request wrapper. Requires Guesty Pro (Lite has no API).
 * Reserved for future use.
 */
export async function guestyRequest(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const apiKey = env.GUESTY_API_KEY;
  if (!apiKey) throw new Error('GUESTY_API_KEY not configured (requires Guesty Pro)');

  const url = `https://api.guesty.com${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${apiKey}`);
  headers.set('accept', 'application/json');

  return fetch(url, { ...init, headers });
}
