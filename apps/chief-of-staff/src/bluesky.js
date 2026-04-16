/**
 * bluesky.js — Bluesky / AT Protocol client for the chief-of-staff worker.
 *
 * Fetches liked posts via the ATProto lexicons using an app password.
 * No npm dependencies — runs on Cloudflare's native fetch API.
 *
 * Credentials (set via `wrangler secret put`):
 *   BLUESKY_HANDLE       — your Bluesky handle, e.g. "you.bsky.social"
 *   BLUESKY_APP_PASSWORD — an app password from Settings → App Passwords
 *   BLUESKY_PDS          — (optional) PDS URL, defaults to "https://bsky.social"
 */

const DEFAULT_PDS = "https://bsky.social";

/**
 * createBluesky(env) — returns a Bluesky API client, or null if credentials
 * are not configured (BLUESKY_HANDLE or BLUESKY_APP_PASSWORD unset).
 */
export function createBluesky(env) {
  const handle = (env.BLUESKY_HANDLE || "").replace(/^@/, "").trim();
  const appPassword = (env.BLUESKY_APP_PASSWORD || "").trim();
  const pds = (env.BLUESKY_PDS || DEFAULT_PDS).replace(/\/$/, "");

  if (!handle || !appPassword) return null;

  // Session token is cached inside the closure for the lifetime of this client
  // instance (one Worker isolate invocation). A new instance is created per
  // cron trigger / fetch request, so the token is always fresh.
  let _session = null;

  async function authenticate() {
    const res = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: handle, password: appPassword }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bluesky auth failed (${res.status}): ${body.slice(0, 300)}`);
    }
    _session = await res.json();
    return _session;
  }

  async function getSession() {
    if (!_session) await authenticate();
    return _session;
  }

  async function apiFetch(lexicon, params = {}) {
    const s = await getSession();
    const url = new URL(`${pds}/xrpc/${lexicon}`);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${s.accessJwt}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bluesky ${lexicon} (${res.status}): ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  /**
   * List the authenticated user's like records, newest first.
   *
   * Returns { records: [{uri, cid, value: {subject: {uri, cid}, createdAt}}], cursor? }
   */
  async function listLikes({ limit = 100, cursor } = {}) {
    const s = await getSession();
    const params = {
      repo: s.did,
      collection: "app.bsky.feed.like",
      limit: Math.min(limit, 100),
    };
    if (cursor) params.cursor = cursor;
    return apiFetch("com.atproto.repo.listRecords", params);
  }

  /**
   * Fetch full post views for up to 25 AT-proto URIs at once.
   * Returns { posts: [{uri, cid, author, record, ...}] }
   */
  async function getPosts(uris) {
    if (!uris || uris.length === 0) return { posts: [] };
    const s = await getSession();
    const url = new URL(`${pds}/xrpc/app.bsky.feed.getPosts`);
    // The API accepts repeated ?uris= params
    for (const uri of uris.slice(0, 25)) url.searchParams.append("uris", uri);
    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${s.accessJwt}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bluesky getPosts (${res.status}): ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  return { listLikes, getPosts };
}
