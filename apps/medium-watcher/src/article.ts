/**
 * Fetch a Medium article URL while replaying the subscriber's cookie, then
 * extract clean body text via HTMLRewriter. The cookie is sourced from the
 * credential vault — keys are scoped by (agentId='medium-watcher',
 * accountId='default', provider='medium', kind='cookie').
 *
 * Medium serves a different HTML body to logged-in members vs. anonymous
 * visitors — without the cookie the request returns the metered-paywall
 * preview. With the cookie, the full article HTML is in the page.
 *
 * Detection of paywall-fallback HTML: if the response has fewer than
 * MIN_BODY_CHARS of extracted text, we treat the cookie as stale and
 * tag the credential metadata so the operator can refresh it.
 */

import { D1CredentialVault } from "@agentbuilder/credential-vault";
import { importKey } from "@agentbuilder/crypto";
import type { Env } from "./types";

const ARTICLE_HEADERS_BASE: Record<string, string> = {
  "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  Accept:            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control":   "no-cache",
};

const MIN_BODY_CHARS = 800;
const FETCH_TIMEOUT_MS = 20_000;

export interface ExtractedArticle {
  title:        string | null;
  author:       string | null;
  publishedAt:  string | null;
  fullText:     string;
  canonicalUrl: string | null;
  /** True when the body was so short we suspect the cookie didn't authenticate. */
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

export function makeVault(env: Env, key: CryptoKey): D1CredentialVault {
  return new D1CredentialVault({ db: env.VAULT_DB, encryptionKey: key });
}

export async function loadCookie(env: Env): Promise<string | null> {
  const key = await vaultKey(env);
  const vault = makeVault(env, key);
  const cred = await vault.get({
    agentId:   "medium-watcher",
    accountId: "default",
    provider:  "medium",
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
  const extracted = await extract(html, url);
  const looksPaywalled = !cookie || extracted.fullText.length < MIN_BODY_CHARS;

  return { ...extracted, looksPaywalled };
}

interface Acc {
  title:        string | null;
  ogTitle:      string | null;
  author:       string | null;
  publishedAt:  string | null;
  canonicalUrl: string | null;
  jsonLdBuf:    string;
  inJsonLd:     boolean;
  jsonLdBlocks: string[];
  inArticle:    boolean;
  skipDepth:    number;
  bodyLines:    string[];
  current:      string;
  inTitleEl:    boolean;
}

const SKIP_TAGS = ["script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form", "button", "iframe", "figure"];
const BLOCK_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre"];

async function extract(html: string, url: string): Promise<Omit<ExtractedArticle, "looksPaywalled">> {
  const acc: Acc = {
    title: null, ogTitle: null, author: null, publishedAt: null, canonicalUrl: null,
    jsonLdBuf: "", inJsonLd: false, jsonLdBlocks: [],
    inArticle: false, skipDepth: 0, bodyLines: [], current: "", inTitleEl: false,
  };

  let rewriter = new HTMLRewriter()
    .on("title", {
      element() { acc.inTitleEl = true; },
      text(c)   { if (acc.inTitleEl) acc.title = (acc.title ?? "") + c.text; },
    })
    .on('link[rel="canonical"]', {
      element(el) { acc.canonicalUrl = el.getAttribute("href"); },
    })
    .on("meta", {
      element(el) {
        const prop = el.getAttribute("property")?.toLowerCase() ?? "";
        const name = el.getAttribute("name")?.toLowerCase() ?? "";
        const content = el.getAttribute("content") ?? "";
        if (!content) return;
        if (prop === "og:title")               acc.ogTitle     = content;
        if (prop === "article:author" || name === "author") acc.author = content;
        if (prop === "article:published_time") acc.publishedAt = content;
      },
    })
    .on('script[type="application/ld+json"]', {
      element() { acc.inJsonLd = true; acc.jsonLdBuf = ""; },
      text(c) {
        if (!acc.inJsonLd) return;
        acc.jsonLdBuf += c.text;
        if (c.lastInTextNode) {
          acc.jsonLdBlocks.push(acc.jsonLdBuf);
          acc.inJsonLd = false;
          acc.jsonLdBuf = "";
        }
      },
    })
    .on("article", {
      element(el) {
        acc.inArticle = true;
        el.onEndTag(() => { acc.inArticle = false; });
      },
    });

  rewriter = rewriter.on(SKIP_TAGS.join(","), {
    element(el) {
      if (!acc.inArticle) return;
      acc.skipDepth++;
      el.onEndTag(() => { acc.skipDepth = Math.max(0, acc.skipDepth - 1); });
    },
  });

  rewriter = rewriter.on(BLOCK_TAGS.join(","), {
    element(el) {
      if (!acc.inArticle || acc.skipDepth > 0) return;
      acc.current = "";
      el.onEndTag(() => {
        if (!acc.inArticle || acc.skipDepth > 0) return;
        const line = acc.current.replace(/\s+/g, " ").trim();
        if (line.length > 0) acc.bodyLines.push(line);
        acc.current = "";
      });
    },
    text(c) {
      if (!acc.inArticle || acc.skipDepth > 0) return;
      acc.current += c.text;
    },
  });

  // Drain the response body so the rewriter handlers fire.
  await rewriter.transform(new Response(html)).text();

  const jsonLd = parseJsonLd(acc.jsonLdBlocks);
  const title  = (jsonLd.title ?? acc.ogTitle ?? acc.title ?? null)?.trim() ?? null;
  const author = (jsonLd.author ?? acc.author ?? null)?.trim() ?? null;
  const publishedAt = normaliseDate(jsonLd.publishedAt ?? acc.publishedAt ?? null);
  const canonicalUrl = acc.canonicalUrl ?? url;
  const fullText = dedupe(acc.bodyLines).join("\n");
  return { title, author, publishedAt, fullText, canonicalUrl };
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (l.length < 3 || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

function normaliseDate(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

interface JsonLdArticle {
  "@type"?:       string | string[];
  headline?:      string;
  author?:        { name?: string } | string | Array<{ name?: string }>;
  datePublished?: string;
}

function parseJsonLd(blocks: string[]): Partial<{ title: string; author: string; publishedAt: string }> {
  const out: Partial<{ title: string; author: string; publishedAt: string }> = {};
  for (const raw of blocks) {
    let data: unknown;
    try { data = JSON.parse(raw.trim()); } catch { continue; }
    const nodes: unknown[] = Array.isArray(data)
      ? data
      : (data as Record<string, unknown>)["@graph"]
        ? ((data as Record<string, unknown>)["@graph"] as unknown[])
        : [data];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const n = node as JsonLdArticle;
      const types = Array.isArray(n["@type"]) ? n["@type"] : [n["@type"] ?? ""];
      if (!types.some((t) => ["Article", "NewsArticle", "BlogPosting"].includes(t))) continue;
      if (!out.title && n.headline) out.title = n.headline.trim();
      if (!out.publishedAt && n.datePublished) out.publishedAt = n.datePublished;
      if (!out.author && n.author) {
        if (typeof n.author === "string") out.author = n.author;
        else if (Array.isArray(n.author)) out.author = n.author[0]?.name ?? undefined;
        else if (typeof n.author === "object" && n.author.name) out.author = n.author.name;
      }
      if (out.title && out.author && out.publishedAt) return out;
    }
  }
  return out;
}
