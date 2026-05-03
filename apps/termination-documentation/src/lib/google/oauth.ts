/**
 * OAuth 2.0 authorization-code flow for Google.
 *
 * Flow:
 *   GET  /oauth/google/start?user_id=<id>
 *     → redirects to Google consent screen with a signed state token
 *   GET  /oauth/google/callback?code=<>&state=<>
 *     → exchanges the code for tokens, writes them to the shared
 *       @agentbuilder/auth-google vault keyed by (agentId, userId).
 *
 * State tokens are HMAC-SHA256-signed JSON blobs carrying user_id + nonce
 * + expiry, so an attacker can't forge a callback to attach tokens to
 * somebody else's userId.
 */

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Scopes requested at consent. */
export const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
];

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Fully-qualified redirect URI registered with the Google OAuth client. */
  redirectUri: string;
  /** Secret used to sign the state parameter. Any stable Worker secret works. */
  stateSecret: string;
}

export interface OAuthState {
  user_id: string;
  nonce: string;
  exp: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

// ── URL construction ────────────────────────────────────────────────────────

export async function buildAuthUrl(cfg: OAuthConfig, userId: string): Promise<string> {
  if (!userId) throw new Error('user_id is required');
  const state = await signState(cfg.stateSecret, {
    user_id: userId,
    nonce: crypto.randomUUID(),
    exp: Date.now() + STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline', // request a refresh token
    prompt: 'consent', // force consent so a refresh token is returned even on re-auth
    include_granted_scopes: 'true',
    state,
  });

  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// ── Code exchange ───────────────────────────────────────────────────────────

export async function exchangeCode(cfg: OAuthConfig, code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable)');
    throw new Error(`OAuth code exchange failed: HTTP ${res.status} — ${text.slice(0, 500)}`);
  }
  return (await res.json()) as TokenResponse;
}

// ── State signing (HMAC-SHA256) ─────────────────────────────────────────────

export async function signState(secret: string, payload: OAuthState): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payloadJson));
  const sig = await hmacSha256(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

export async function verifyState(secret: string, token: string): Promise<OAuthState> {
  const dot = token.indexOf('.');
  if (dot < 0) throw new Error('Invalid state: no signature');
  const payloadB64 = token.slice(0, dot);
  const suppliedSig = token.slice(dot + 1);

  const expectedSig = await hmacSha256(secret, payloadB64);
  if (!timingSafeEqual(suppliedSig, expectedSig)) {
    throw new Error('Invalid state: signature mismatch');
  }

  const json = new TextDecoder().decode(base64UrlDecode(payloadB64));
  const payload = JSON.parse(json) as OAuthState;
  if (!payload.user_id || !payload.nonce || typeof payload.exp !== 'number') {
    throw new Error('Invalid state: malformed payload');
  }
  if (Date.now() > payload.exp) {
    throw new Error('Invalid state: expired — restart the OAuth flow.');
  }
  return payload;
}

// ── Crypto helpers ──────────────────────────────────────────────────────────

async function hmacSha256(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(sig));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
