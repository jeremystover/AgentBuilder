/**
 * Resolve a Google access token from the shared token vault.
 *
 * Returns either { ok: true, token } or { ok: false, reason } where the
 * reason is a structured string the model can relay to the user. No
 * exceptions are thrown for the missing-infrastructure case — that's the
 * default state for this agent until OAuth + D1 are wired up.
 */

import { D1TokenVault, importKey } from '@agentbuilder/auth-google';
import type { Env } from '../../../worker-configuration';

const AGENT_ID = 'termination-documentation';

export type TokenResolution =
  | { ok: true; token: string; scopes: string; userId: string }
  | { ok: false; reason: string };

export async function resolveGoogleAccessToken(
  env: Env,
  userId: string,
): Promise<TokenResolution> {
  if (!env.DB) {
    return {
      ok: false,
      reason:
        'Google integration is not wired up on this Worker deployment. Add the D1 binding (agentbuilder-core) to wrangler.toml and redeploy.',
    };
  }
  if (!env.GOOGLE_TOKEN_VAULT_KEK) {
    return {
      ok: false,
      reason:
        'GOOGLE_TOKEN_VAULT_KEK secret is missing. Provision it via `wrangler secret put GOOGLE_TOKEN_VAULT_KEK --name termination-documentation` (use the same base64 KEK as other Google-touching agents).',
    };
  }

  let kek: CryptoKey;
  try {
    const kekBuffer = base64ToArrayBuffer(env.GOOGLE_TOKEN_VAULT_KEK);
    kek = await importKey(kekBuffer);
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to import GOOGLE_TOKEN_VAULT_KEK (${err instanceof Error ? err.message : String(err)}). Confirm it is valid base64 of a 32-byte AES-256 key.`,
    };
  }

  const vault = new D1TokenVault({ db: env.DB, encryptionKey: kek });
  const stored = await vault.get({ agentId: AGENT_ID, userId });

  if (!stored) {
    return {
      ok: false,
      reason:
        "No Google OAuth token found for this user. Complete the one-time OAuth consent at the agent's /oauth/google/start endpoint to grant Drive + Docs access. Until then, the agent will skip Drive folder creation and Google Doc output; the checklist, chronology, and markdown memo still work locally.",
    };
  }

  // Access tokens are short-lived. If expired, we surface a refresh prompt —
  // the refresh flow itself is scaffolded for a future commit.
  if (stored.expiresAt <= Date.now()) {
    return {
      ok: false,
      reason:
        'Google access token has expired. Complete /oauth/google/refresh (or re-run /oauth/google/start) to refresh.',
    };
  }

  return {
    ok: true,
    token: stored.accessToken,
    scopes: stored.scopes,
    userId,
  };
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
