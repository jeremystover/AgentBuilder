/**
 * Skill: platform-api-integration
 *
 * Thin auth + request wrappers for Guesty REST, Airbnb API, VRBO iCal,
 * and Booking.com Connectivity API. Every outbound platform call goes
 * through here so rate-limit handling, caching (via env.CACHE), and
 * secret rotation stay in one place.
 *
 * Status: stub — Guesty is the only near-term target; the others land
 * when `guest-booking` reaches parity with `booking-sync`.
 */
import type { Env } from '../../worker-configuration';

export async function guestyRequest(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const apiKey = env.GUESTY_API_KEY;
  if (!apiKey) throw new Error('GUESTY_API_KEY not configured');

  const url = `https://api.guesty.com${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${apiKey}`);
  headers.set('accept', 'application/json');

  return fetch(url, { ...init, headers });
}
