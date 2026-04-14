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
 *    Obtain the refresh token once via: bin/google-auth
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

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });

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
    const token = await getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    };
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google API ${res.status}: ${body}`);
    }
    return res;
  }

  return { gfetch, getAccessToken };
}

// ── OAuth2 user token (Gmail + Calendar) ─────────────────────────────────────
// Keyed by client_id so multiple OAuth apps coexist cleanly.
const _userTokenCache = new Map(); // clientId -> { token, expiresAt }

/**
 * createUserFetch(env) — factory that returns a user-OAuth-authenticated fetch.
 *
 * Uses the offline refresh token stored in env to obtain short-lived access
 * tokens via the standard OAuth2 token endpoint. Token is cached per isolate.
 *
 * Required secrets:
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_OAUTH_REFRESH_TOKEN  (obtained once via bin/google-auth)
 *
 * Returns { ufetch, getUserAccessToken }.
 */
export function createUserFetch(env) {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN || "";

  async function getUserAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    const cached = _userTokenCache.get(clientId);
    if (cached && cached.expiresAt > now + 60) return cached.token;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "OAuth2 credentials not configured. Set GOOGLE_OAUTH_CLIENT_ID, " +
        "GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN via wrangler secret put. " +
        "Run bin/google-auth to obtain the refresh token."
      );
    }

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OAuth2 token refresh failed: ${res.status} ${body}`);
    }

    const json = await res.json();
    const token = json.access_token;
    _userTokenCache.set(clientId, { token, expiresAt: now + (json.expires_in || 3600) });
    return token;
  }

  async function ufetch(url, options = {}) {
    const token = await getUserAccessToken();
    const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google API ${res.status}: ${body}`);
    }
    return res;
  }

  return { ufetch, getUserAccessToken };
}
