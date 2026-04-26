import type { Env } from "./types";

export interface AuthResult  { ok: true;  error?: never; }
export interface AuthFailure { ok: false; error: string; status: 401 | 403; }
export type AuthCheck = AuthResult | AuthFailure;
  
/**
 * Timing-safe string comparison using HMAC-SHA-256.
 * Signs both strings with a per-request throwaway key so the
 * comparison is on fixed-length MACs, not variable-length strings.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();

  // Cast to CryptoKey — generateKey with a non-pair algorithm always returns CryptoKey,
  // but the Web Crypto typings return CryptoKey | CryptoKeyPair.
  const key = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  ) as CryptoKey;

  const [macA, macB] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);

  const viewA = new Uint8Array(macA);
  const viewB = new Uint8Array(macB);

  if (viewA.byteLength !== viewB.byteLength) return false;

  let diff = 0;
  for (let i = 0; i < viewA.byteLength; i++) {
    diff |= viewA[i]! ^ viewB[i]!;
  }
  return diff === 0;
}

export async function checkAuth(request: Request, env: Env): Promise<AuthCheck> {
  if (!env.MCP_BEARER_TOKEN) {
    console.error("[auth] MCP_BEARER_TOKEN secret is not set");
    return { ok: false, error: "Server auth not configured", status: 401 };
  }

  // Accept key from either:
  //   1. Authorization: Bearer <token>  header
  //   2. ?key=<token>                   query param (for clients that don't support headers)
  let provided: string | null = null;

  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    provided = authHeader.slice("Bearer ".length).trim() || null;
  }

  if (!provided) {
    const url = new URL(request.url);
    provided = url.searchParams.get("key");
  }

  if (!provided) {
    return { ok: false, error: "Missing auth — provide Authorization: Bearer <token> header or ?key=<token> query param", status: 401 };
  }

  const valid = await timingSafeEqual(provided, env.MCP_BEARER_TOKEN);
  if (valid) return { ok: true };

  // Also accept the fleet-internal shared secret so other agents (e.g. linkedin-watcher)
  // can post to /ingest without needing the human-facing MCP bearer token.
  if (env.INTERNAL_SECRET) {
    const validInternal = await timingSafeEqual(provided, env.INTERNAL_SECRET);
    if (validInternal) return { ok: true };
  }

  return { ok: false, error: "Invalid token", status: 403 };
}

export function authErrorResponse(failure: AuthFailure): Response {
  return new Response(JSON.stringify({ error: failure.error }), {
    status:  failure.status,
    headers: {
      "Content-Type":           "application/json",
      "WWW-Authenticate":       'Bearer realm="content-brain"',
      "X-Content-Type-Options": "nosniff",
    },
  });
}
