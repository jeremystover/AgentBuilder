/**
 * auth.js — Google auth for Cloudflare Workers.
 *
 * Two auth modes, both cached at module level:
 *
 * 1. Service Account (Sheets + Drive):
 *    createGfetch(env) — signs JWTs via Web Crypto, caches access token.
 *    Required secret: GOOGLE_SERVICE_ACCOUNT_JSON
 *
 * 2. OAuth2 user token (Gmail + Calendar read/write):
 *    createUserFetch(env) — exchanges refresh token for access token.
 *    Required secrets: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
 *                      GOOGLE_OAUTH_REFRESH_TOKEN
 *    Obtain the refresh token once via: node scripts/google-auth.js
 */

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isTransientGoogleErrorMessage(msg) {
  return (
    msg.includes("Google API 404") ||
    msg.includes("Google API 409") ||
    msg.includes("Google API 429") ||
    msg.includes("Google API 500") ||
    msg.includes("Google API 502") ||
    msg.includes("Google API 503") ||
    msg.includes("Google API 504")
  );
}

export async function withRetry(fn, { tries = 4, baseMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || "");
      const transient = isTransientGoogleErrorMessage(msg);
      if (!transient || i === tries - 1) throw e;
      const backoff = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 100);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// Retry wrapper specifically for the Google token endpoint.
// Retries on 429 / 5xx (transient) but passes 4xx through immediately
// (invalid_grant, invalid_client, etc. are permanent and shouldn't be retried).
async function fetchTokenEndpoint(bodyStr, { tries = 4, baseMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: bodyStr,
    });
    if (res.status === 429 || res.status >= 500) {
      lastErr = res;
      if (i < tries - 1) {
        await sleep(baseMs * Math.pow(2, i) + Math.floor(Math.random() * 100));
        continue;
      }
    }
    return res;
  }
  return lastErr;
}

// ── JWT signing helpers (Web Crypto, works in Cloudflare Workers) ────────────

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function pemToDer(pem) {
  const b64 = pem
    .replace(/-----BEGIN[^-]*-----/g, "")
    .replace(/-----END[^-]*-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signRs256Jwt(header, payload, privateKeyPem) {
  const der = pemToDer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const enc = new TextEncoder();
  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const sigInput = enc.encode(`${headerB64}.${payloadB64}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, sigInput);

  return `${headerB64}.${payloadB64}.${base64UrlEncode(sig)}`;
}

// ── Module-level token cache (lives for the lifetime of the V8 isolate) ──────
// Keyed by service account email so multiple SA configs coexist cleanly.
const _tokenCache = new Map(); // email -> { token, expiresAt (unix seconds) }

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
].join(" ");

/**
 * createGfetch(env) — factory that returns a Google-authenticated fetch wrapper.
 *
 * Parses GOOGLE_SERVICE_ACCOUNT_JSON from env, signs JWTs via Web Crypto,
 * and caches the access token for the lifetime of the isolate.
 *
 * Returns { gfetch, getAccessToken }.
 */
export function createGfetch(env) {
  let saJson;
  try {
    saJson = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
  } catch {
    saJson = {};
  }

  const clientEmail = saJson.client_email || "";
  const privateKey = saJson.private_key || "";

  async function getAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    const cached = _tokenCache.get(clientEmail);
    if (cached && cached.expiresAt > now + 60) return cached.token;

    if (!privateKey || !clientEmail) {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_JSON is missing or invalid — set this secret via `wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON`"
      );
    }

    const iat = now;
    const exp = now + 3600;

    const jwt = await signRs256Jwt(
      { alg: "RS256", typ: "JWT" },
      { iss: clientEmail, scope: SCOPES, aud: "https://oauth2.googleapis.com/token", exp, iat },
      privateKey
    );

    const res = await fetchTokenEndpoint(
      `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Failed to obtain access token: ${res.status} ${body}`);
    }

    const json = await res.json();
    const token = json.access_token;
    _tokenCache.set(clientEmail, { token, expiresAt: now + (json.expires_in || 3600) });
    return token;
  }

  async function gfetch(url, options = {}) {
    let token = await getAccessToken();
    const makeHeaders = (t) => ({ Authorization: `Bearer ${t}`, ...(options.headers || {}) });
    let res = await fetch(url, { ...options, headers: makeHeaders(token) });
    if (res.status === 401) {
      // Token was rejected — evict cache entry and retry once with a fresh token.
      _tokenCache.delete(clientEmail);
      token = await getAccessToken();
      res = await fetch(url, { ...options, headers: makeHeaders(token) });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google API ${res.status}: ${body}`);
    }
    return res;
  }

  return { gfetch, getAccessToken };
}

// ── OAuth2 user token (Gmail + Calendar) ─────────────────────────────────────
// Keyed by `${account}:${clientId}` so multiple OAuth apps / accounts coexist
// cleanly in a single isolate.
const _userTokenCache = new Map();

// The canonical name for the default account. When account === DEFAULT_ACCOUNT
// the env vars are read from the bare names (GOOGLE_OAUTH_CLIENT_ID, etc.) to
// preserve backward compatibility with the original single-account setup.
export const DEFAULT_ACCOUNT = "personal";

// Named accounts use an infix convention: the account name is inserted
// between the "GOOGLE_OAUTH_" prefix and the field suffix, e.g.
//
//   personal → GOOGLE_OAUTH_CLIENT_ID
//   gong     → GOOGLE_OAUTH_GONG_CLIENT_ID
//
// This keeps the field names (CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN)
// aligned across every account so it's easy to scan secrets in Cloudflare.
function envVarForAccount(fieldSuffix, account) {
  if (!account || account === DEFAULT_ACCOUNT) {
    return `GOOGLE_OAUTH_${fieldSuffix}`;
  }
  return `GOOGLE_OAUTH_${account.toUpperCase()}_${fieldSuffix}`;
}

/**
 * createUserFetch(env, account) — factory that returns a user-OAuth-
 * authenticated fetch for the named Google account.
 *
 * Uses the offline refresh token stored in env to obtain short-lived access
 * tokens via the standard OAuth2 token endpoint. Token is cached per isolate.
 *
 * Secret naming:
 *   "personal" (default) — GOOGLE_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN
 *   any other account    — GOOGLE_OAUTH_<ACCOUNT>_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN
 *                          e.g. GOOGLE_OAUTH_GONG_CLIENT_ID
 *
 * Returns { ufetch, getUserAccessToken, account }.
 */
export function createUserFetch(env, account = DEFAULT_ACCOUNT) {
  const clientIdVar = envVarForAccount("CLIENT_ID", account);
  const clientSecretVar = envVarForAccount("CLIENT_SECRET", account);
  const refreshTokenVar = envVarForAccount("REFRESH_TOKEN", account);

  const clientId = env[clientIdVar] || "";
  const clientSecret = env[clientSecretVar] || "";
  const refreshToken = env[refreshTokenVar] || "";
  const cacheKey = `${account}:${clientId}`;

  async function getUserAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    const cached = _userTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > now + 60) return cached.token;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        `OAuth2 credentials not configured for account '${account}'. ` +
        `Set ${clientIdVar}, ${clientSecretVar}, ${refreshTokenVar} via wrangler secret put. ` +
        "Run scripts/google-auth.js to obtain the refresh token."
      );
    }

    const res = await fetchTokenEndpoint(
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString()
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OAuth2 token refresh failed for '${account}': ${res.status} ${body}`);
    }

    const json = await res.json();
    const token = json.access_token;
    _userTokenCache.set(cacheKey, { token, expiresAt: now + (json.expires_in || 3600) });
    return token;
  }

  async function ufetch(url, options = {}) {
    let token = await getUserAccessToken();
    const makeHeaders = (t) => ({ Authorization: `Bearer ${t}`, ...(options.headers || {}) });
    let res = await fetch(url, { ...options, headers: makeHeaders(token) });
    if (res.status === 401) {
      // Token was rejected — evict cache entry and retry once with a fresh token.
      _userTokenCache.delete(cacheKey);
      token = await getUserAccessToken();
      res = await fetch(url, { ...options, headers: makeHeaders(token) });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google API ${res.status} (${account}): ${body}`);
    }
    return res;
  }

  return { ufetch, getUserAccessToken, account };
}

/**
 * createUserFetches(env) — discover every configured Google OAuth account in
 * env and return a map of { accountName -> { ufetch, getUserAccessToken } }.
 *
 * The default account ("personal") is included whenever GOOGLE_OAUTH_CLIENT_ID
 * is set. Additional accounts are discovered by scanning env for env vars of
 * the form GOOGLE_OAUTH_<ACCOUNT>_CLIENT_ID; each match becomes an entry
 * keyed by the lowercased account name (e.g. "gong").
 *
 * Callers that only need the default account can simply read `.personal`.
 * Callers that need to dispatch on an account name (tool `account` param,
 * multi-account ingest) should use this map with getUserFetch() below.
 */
export function createUserFetches(env) {
  const out = {};
  if (env && env.GOOGLE_OAUTH_CLIENT_ID) {
    out[DEFAULT_ACCOUNT] = createUserFetch(env, DEFAULT_ACCOUNT);
  }
  for (const key of Object.keys(env || {})) {
    // Match GOOGLE_OAUTH_<ACCOUNT>_CLIENT_ID but NOT the bare
    // GOOGLE_OAUTH_CLIENT_ID (which belongs to the default account).
    const m = key.match(/^GOOGLE_OAUTH_(.+)_CLIENT_ID$/);
    if (!m) continue;
    // Reject the degenerate captures that would collide with field names
    // (CLIENT, REFRESH, etc. as an "account"). These can only appear if the
    // user names a suffixed variant that happens to mirror a field; skip.
    const account = m[1].toLowerCase();
    if (!account || account === DEFAULT_ACCOUNT) continue;
    if (!env[key]) continue;
    out[account] = createUserFetch(env, account);
  }
  return out;
}

/**
 * getUserFetch(userFetches, account) — pick an account's ufetch with a clear
 * error message if the caller asked for one that isn't configured. Use this
 * inside tool handlers that accept an `account` input parameter.
 */
export function getUserFetch(userFetches, account = DEFAULT_ACCOUNT) {
  const entry = userFetches && userFetches[account];
  if (!entry) {
    const available = Object.keys(userFetches || {}).join(", ") || "(none)";
    const upper = account.toUpperCase();
    throw new Error(
      `OAuth account '${account}' not configured. Available accounts: ${available}. ` +
      `Set GOOGLE_OAUTH_${upper}_CLIENT_ID, ` +
      `GOOGLE_OAUTH_${upper}_CLIENT_SECRET, ` +
      `GOOGLE_OAUTH_${upper}_REFRESH_TOKEN via wrangler secret put.`
    );
  }
  return entry.ufetch;
}
