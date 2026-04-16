/**
 * poll_bluesky — Cron handler
 *
 * Every 30 minutes:
 *   1. Auth with BLUESKY_IDENTIFIER + BLUESKY_APP_PASSWORD via AT Protocol
 *   2. Fetch the home timeline since last cursor for each enabled Bluesky source
 *   3. Also run any keyword searches configured as sources (type=bluesky, url=search:<term>)
 *   4. Extract linked article URLs from post text
 *   5. Call ingestUrl() for each novel URL
 *   6. Save the updated cursor back to D1
 */

import type { Env } from "../types";
import { ingestUrl } from "../mcp/tools/ingest_url";

// ── AT Protocol types (minimal subset we need) ────────────────

interface AtSession {
  accessJwt:  string;
  refreshJwt: string;
  did:        string;
}

interface AtPost {
  uri:    string;
  cid:    string;
  record: {
    "$type":   string;
    text?:     string;
    facets?:   AtFacet[];
    embed?:    AtEmbed;
    createdAt: string;
  };
}

interface AtFacet {
  features: Array<{ "$type": string; uri?: string }>;
}

interface AtEmbed {
  "$type":   string;
  external?: { uri: string; title?: string; description?: string };
  record?:   unknown;
}

interface AtTimelineResponse {
  feed:   Array<{ post: AtPost }>;
  cursor?: string;
}

interface AtSearchResponse {
  posts:   AtPost[];
  cursor?: string;
}

// ── Constants ─────────────────────────────────────────────────

const BSKY_API    = "https://bsky.social/xrpc";
const MAX_PER_RUN = 50; // max articles to ingest per poll run (guards against runaway)

// URL regex — same as email handler
const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gi;

// Domains to skip — Bluesky's own domains, common noise
const SKIP_DOMAINS = new Set([
  "bsky.app", "bsky.social", "staging.bsky.app",
  "t.co", "bit.ly", "tinyurl.com",
]);

// ── Auth ──────────────────────────────────────────────────────

async function createSession(identifier: string, password: string): Promise<AtSession> {
  const res = await fetch(`${BSKY_API}/com.atproto.server.createSession`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ identifier, password }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Bluesky auth failed: ${res.status} ${body}`);
  }

  return res.json() as Promise<AtSession>;
}

// ── URL extraction from post ───────────────────────────────────

function extractUrlsFromPost(post: AtPost): string[] {
  const urls = new Set<string>();

  // 1. Facets (rich text links — most reliable)
  for (const facet of post.record.facets ?? []) {
    for (const feature of facet.features) {
      if (feature["$type"] === "app.bsky.richtext.facet#link" && feature.uri) {
        urls.add(feature.uri);
      }
    }
  }

  // 2. External embed (link card)
  if (post.record.embed?.["$type"] === "app.bsky.embed.external" && post.record.embed.external?.uri) {
    urls.add(post.record.embed.external.uri);
  }

  // 3. Bare URLs in text (fallback)
  const text = post.record.text ?? "";
  for (const match of text.matchAll(URL_RE)) {
    urls.add(match[0]!);
  }

  // Filter noise
  return [...urls].filter((u) => {
    try {
      const host = new URL(u).hostname.replace(/^www\./, "");
      return !SKIP_DOMAINS.has(host);
    } catch {
      return false;
    }
  });
}

// ── Timeline fetch ────────────────────────────────────────────

async function fetchTimeline(
  session: AtSession,
  cursor?: string,
  limit = 50,
): Promise<AtTimelineResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);

  const res = await fetch(
    `${BSKY_API}/app.bsky.feed.getTimeline?${params}`,
    { headers: { Authorization: `Bearer ${session.accessJwt}` } },
  );

  if (!res.ok) throw new Error(`Timeline fetch failed: ${res.status}`);
  return res.json() as Promise<AtTimelineResponse>;
}

// ── Author feed fetch (for specific accounts) ─────────────────

async function fetchAuthorFeed(
  session: AtSession,
  actor:   string,
  cursor?: string,
  limit = 50,
): Promise<AtTimelineResponse> {
  const params = new URLSearchParams({ actor, limit: String(limit), filter: "posts_with_links" });
  if (cursor) params.set("cursor", cursor);

  const res = await fetch(
    `${BSKY_API}/app.bsky.feed.getAuthorFeed?${params}`,
    { headers: { Authorization: `Bearer ${session.accessJwt}` } },
  );

  if (!res.ok) throw new Error(`Author feed fetch failed for ${actor}: ${res.status}`);
  return res.json() as Promise<AtTimelineResponse>;
}

// ── Search fetch ──────────────────────────────────────────────

async function fetchSearch(
  session: AtSession,
  query:   string,
  cursor?: string,
  limit = 25,
): Promise<AtSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (cursor) params.set("cursor", cursor);

  const res = await fetch(
    `${BSKY_API}/app.bsky.feed.searchPosts?${params}`,
    { headers: { Authorization: `Bearer ${session.accessJwt}` } },
  );

  if (!res.ok) throw new Error(`Search fetch failed for "${query}": ${res.status}`);
  return res.json() as Promise<AtSearchResponse>;
}

// ── Source cursor helpers ─────────────────────────────────────

interface DbSource {
  id:          string;
  type:        string;
  name:        string;
  url:         string | null;
  enabled:     number;
  poll_cursor: string | null;
}

async function getBluesskySources(env: Env): Promise<DbSource[]> {
  const result = await env.CONTENT_DB
    .prepare("SELECT * FROM sources WHERE type = 'bluesky' AND enabled = 1")
    .all<DbSource>();
  return result.results;
}

async function saveCursor(env: Env, sourceId: string, cursor: string): Promise<void> {
  await env.CONTENT_DB
    .prepare("UPDATE sources SET poll_cursor = ?1, last_polled = ?2 WHERE id = ?3")
    .bind(cursor, new Date().toISOString(), sourceId)
    .run();
}

async function markPolled(env: Env, sourceId: string): Promise<void> {
  await env.CONTENT_DB
    .prepare("UPDATE sources SET last_polled = ?1 WHERE id = ?2")
    .bind(new Date().toISOString(), sourceId)
    .run();
}

// ── Main export ───────────────────────────────────────────────

export async function runPollBluesky(env: Env): Promise<void> {
  if (!env.BLUESKY_IDENTIFIER || !env.BLUESKY_APP_PASSWORD) {
    console.log("[poll_bluesky] BLUESKY_IDENTIFIER or BLUESKY_APP_PASSWORD not set — skipping");
    return;
  }

  // Auth
  let session: AtSession;
  try {
    session = await createSession(env.BLUESKY_IDENTIFIER, env.BLUESKY_APP_PASSWORD);
  } catch (e) {
    console.error("[poll_bluesky] auth failed:", e);
    return;
  }

  const sources = await getBluesskySources(env);

  if (sources.length === 0) {
    // No specific sources configured — poll home timeline
    console.log("[poll_bluesky] no Bluesky sources configured, polling home timeline");
    try {
      const timeline = await fetchTimeline(session, undefined, 50);
      let ingested = 0;

      for (const { post } of timeline.feed) {
        if (ingested >= MAX_PER_RUN) break;
        const urls = extractUrlsFromPost(post);
        for (const url of urls) {
          if (ingested >= MAX_PER_RUN) break;
          try {
            await ingestUrl({ url, source_id: undefined, force_reingest: false }, env, {} as ExecutionContext);
            ingested++;
          } catch (e) {
            console.warn(`[poll_bluesky] ingest failed for ${url}:`, e);
          }
        }
      }

      console.log(`[poll_bluesky] home timeline: ingested ${ingested} articles`);
    } catch (e) {
      console.error("[poll_bluesky] timeline fetch failed:", e);
    }
    return;
  }

  // Poll each configured source
  let totalIngested = 0;

  for (const source of sources) {
    if (totalIngested >= MAX_PER_RUN) break;

    try {
      const isSearch = source.url?.startsWith("search:");
      const posts: AtPost[] = [];
      let newCursor: string | undefined;

      if (isSearch) {
        // Keyword search source — url format: "search:<query>"
        const query = source.url!.slice("search:".length).trim();
        const result = await fetchSearch(session, query, source.poll_cursor ?? undefined);
        posts.push(...result.posts);
        newCursor = result.cursor;
      } else if (source.url) {
        // Author/DID feed source
        const result = await fetchAuthorFeed(session, source.url, source.poll_cursor ?? undefined);
        posts.push(...result.feed.map((f) => f.post));
        newCursor = result.cursor;
      } else {
        // Fallback: home timeline (treat as a general timeline source)
        const result = await fetchTimeline(session, source.poll_cursor ?? undefined);
        posts.push(...result.feed.map((f) => f.post));
        newCursor = result.cursor;
      }

      let sourceIngested = 0;
      for (const post of posts) {
        if (totalIngested >= MAX_PER_RUN) break;
        const urls = extractUrlsFromPost(post);
        for (const url of urls) {
          if (totalIngested >= MAX_PER_RUN) break;
          try {
            await ingestUrl({ url, source_id: source.id, force_reingest: false }, env, {} as ExecutionContext);
            sourceIngested++;
            totalIngested++;
          } catch (e) {
            console.warn(`[poll_bluesky] ingest failed for ${url}:`, e);
          }
        }
      }

      console.log(`[poll_bluesky] source "${source.name}": ingested ${sourceIngested} articles`);

      if (newCursor) await saveCursor(env, source.id, newCursor);
      else           await markPolled(env, source.id);

    } catch (e) {
      console.error(`[poll_bluesky] source "${source.name}" failed:`, e);
      await markPolled(env, source.id); // still update last_polled so we don't retry immediately
    }
  }

  console.log(`[poll_bluesky] run complete — total ingested: ${totalIngested}`);
}
