/**
 * follow_author — turn a stored Medium article into a watch on its author.
 *
 * Looks up the article in research-agent's DB, decides whether it's a
 * Medium URL, derives the author's handle, and POSTs to medium-watcher's
 * `/watch` endpoint with `Authorization: Bearer <INTERNAL_SECRET>` (the
 * fleet-internal auth that medium-watcher accepts in addition to its own
 * WATCHER_API_KEY).
 *
 * Two Medium URL shapes:
 *
 *   - Author-hosted:  https://medium.com/@danshipper/foo-bar
 *     → handle is in the path, no extra fetch.
 *
 *   - Publication-hosted: https://towardsdatascience.com/foo-bar
 *     or              https://medium.com/towardsdatascience/foo-bar
 *     → URL doesn't carry the handle; we fetch the page (no cookie
 *       required — Medium serves canonical author metadata even on the
 *       metered-paywall preview) and parse <a rel="author"> or JSON-LD.
 *
 * Returns one of: added | already_watched | not_medium | handle_not_found.
 * The first three are normal results; handle_not_found means the URL is
 * Medium-shaped but we couldn't auto-resolve the handle and the operator
 * should add the feed manually.
 */

import { z } from "zod";
import type { Env } from "../../types";
import { articleQueries } from "../../lib/db";

export const FollowAuthorInput = z.object({
  article_id: z.string().uuid().describe("Article UUID from a prior search/get_article result"),
});

export type FollowAuthorInput = z.infer<typeof FollowAuthorInput>;

export interface FollowAuthorOutput {
  status:           "added" | "already_watched" | "not_medium" | "handle_not_found";
  handle?:          string;
  feedUrl?:         string;
  watcherResponse?: unknown;
  message?:         string;
}

const MEDIUM_HOST_RE = /(?:^|\.)medium\.com$/i;
const HANDLE_PATH_RE = /\/@([A-Za-z0-9_.-]+)(?:[/?#]|$)/;

const META_AUTHOR_RE = /<a[^>]+rel=["']author["'][^>]+href=["']([^"']+)["']/i;
const JSONLD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function isMediumUrl(href: string): boolean {
  try {
    return MEDIUM_HOST_RE.test(new URL(href).hostname);
  } catch {
    return false;
  }
}

function handleFromUrl(href: string): string | null {
  try {
    const u = new URL(href);
    if (!MEDIUM_HOST_RE.test(u.hostname)) return null;
    const m = HANDLE_PATH_RE.exec(u.pathname);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

async function handleFromArticleFetch(url: string): Promise<string | null> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ResearchAgent/1.0; +follow_author)",
      Accept:        "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!resp.ok) return null;
  const html = await resp.text();

  const linkAuthor = META_AUTHOR_RE.exec(html);
  if (linkAuthor?.[1]) {
    const h = handleFromUrl(linkAuthor[1]);
    if (h) return h;
  }

  let m: RegExpExecArray | null;
  while ((m = JSONLD_RE.exec(html))) {
    let data: unknown;
    try { data = JSON.parse((m[1] ?? "").trim()); } catch { continue; }
    const nodes: unknown[] = Array.isArray(data)
      ? data
      : (data as Record<string, unknown>)["@graph"]
        ? ((data as Record<string, unknown>)["@graph"] as unknown[])
        : [data];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const author = (node as Record<string, unknown>)["author"];
      if (!author) continue;
      const candidates: unknown[] = Array.isArray(author) ? author : [author];
      for (const c of candidates) {
        if (!c || typeof c !== "object") continue;
        const url = (c as Record<string, unknown>)["url"];
        if (typeof url === "string") {
          const h = handleFromUrl(url);
          if (h) return h;
        }
      }
    }
  }

  return null;
}

export async function followAuthor(input: FollowAuthorInput, env: Env): Promise<FollowAuthorOutput> {
  if (!env.MEDIUM_WATCHER_URL) {
    return { status: "not_medium", message: "MEDIUM_WATCHER_URL is not configured on research-agent" };
  }
  if (!env.INTERNAL_SECRET) {
    return { status: "not_medium", message: "INTERNAL_SECRET is not configured on research-agent" };
  }

  const article = await articleQueries.findById(env.CONTENT_DB, input.article_id);
  if (!article) throw new Error(`Article not found: ${input.article_id}`);

  const candidate = article.canonical_url ?? article.url;
  if (!isMediumUrl(candidate)) {
    return { status: "not_medium", message: `Not a Medium URL: ${candidate}` };
  }

  let handle = handleFromUrl(candidate);
  if (!handle) {
    handle = await handleFromArticleFetch(candidate);
  }
  if (!handle) {
    return {
      status:  "handle_not_found",
      message: `Could not auto-detect author handle from ${candidate}. Add the feed manually if you know it.`,
    };
  }

  const feedUrl = `https://medium.com/feed/@${handle}`;
  const name    = article.author ?? `@${handle}`;

  const watcherUrl = `${env.MEDIUM_WATCHER_URL.replace(/\/+$/, "")}/watch`;
  const resp = await fetch(watcherUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${env.INTERNAL_SECRET}`,
    },
    body: JSON.stringify({ feedUrl, name }),
  });

  const text = await resp.text();
  let watcherResponse: unknown = text;
  try { watcherResponse = JSON.parse(text); } catch { /* keep as string */ }

  if (resp.status === 409) {
    return { status: "already_watched", handle, feedUrl, watcherResponse };
  }
  if (!resp.ok) {
    throw new Error(
      `medium-watcher /watch failed: ${resp.status} ` +
      (typeof watcherResponse === "string" ? watcherResponse : JSON.stringify(watcherResponse)),
    );
  }
  return { status: "added", handle, feedUrl, watcherResponse };
}
