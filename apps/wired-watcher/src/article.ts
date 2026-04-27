/**
 * Fetch a Wired article URL while replaying the subscriber's cookie, then
 * delegate body extraction to @agentbuilder/extract-article.
 *
 * Cookie source: credential vault scoped by
 *   (agentId='wired-watcher', accountId='default', provider='wired', kind='cookie').
 *
 * Condé Nast paywall is server-side cookie-based. The relevant cookies
 * (`wp_user_token`, `CN_SubID`, etc.) come from a logged-in session at
 * wired.com and should be pasted into the vault as a single Cookie:-header
 * value.
 *
 * Bot-detection caveat: Wired occasionally returns a JS challenge HTML
 * instead of the article. The body-length floor catches those alongside
 * stale-cookie cases and tells the operator the credential needs a refresh.
 */

import { D1CredentialVault } from "@agentbuilder/credential-vault";
import { importKey } from "@agentbuilder/crypto";
import { extractArticle, type ExtractedArticle as ExtractedBase } from "@agentbuilder/extract-article";
import type { Env } from "./types";

const ARTICLE_HEADERS_BASE: Record<string, string> = {
  "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  Accept:            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control":   "no-cache",
};

const MIN_BODY_CHARS = 1200;
const FETCH_TIMEOUT_MS = 20_000;

export interface ExtractedArticle extends ExtractedBase {
  /** True when the body was so short we suspect cookie / bot-challenge issues. */
  looksPaywalled: boolean;
}

let cachedKey: CryptoKey | null = null;

async function vaultKey(env: Env): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  if (!env.KEK_BASE64) throw new Error("KEK_BASE64 secret is not set");
  const bytes = Uint8Array.from(atob(env.KEK_BASE64), (c) => c.charCodeAt(0));
  if (bytes.byteLength !== 32) {
    throw new Error(`KEK_BASE64 must decode to 32 bytes, got ${bytes.byteLength}`);
  }
  cachedKey = await importKey(bytes.buffer);
  return cachedKey;
}

export async function loadCookie(env: Env): Promise<string | null> {
  const key = await vaultKey(env);
  const vault = new D1CredentialVault({ db: env.VAULT_DB, encryptionKey: key });
  const cred = await vault.get({
    agentId:   "wired-watcher",
    accountId: "default",
    provider:  "wired",
    kind:      "cookie",
  });
  return cred?.value ?? null;
}

export async function fetchArticle(url: string, cookie: string | null): Promise<ExtractedArticle> {
  const headers: Record<string, string> = { ...ARTICLE_HEADERS_BASE };
  if (cookie) headers["Cookie"] = cookie;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`article fetch failed ${response.status} for ${url}`);
  }

  const html = await response.text();
  const extracted = await extractArticle(html, url);
  const looksPaywalled = !cookie || extracted.fullText.length < MIN_BODY_CHARS;

  return { ...extracted, looksPaywalled };
}
