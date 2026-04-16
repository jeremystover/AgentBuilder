/**
 * list_sources — Curation + management tool
 *
 * List, add, or remove ingestion sources:
 *   - Bluesky feeds/lists (polled every 30 min via cron)
 *   - RSS feeds (future)
 *   - Email aliases (informational — configured in Cloudflare dashboard)
 *   - Manual/bookmarklet (always enabled)
 */

import { z } from "zod";
import type { Env } from "../../types";

const SourceSchema = z.object({
  type:    z.enum(["rss", "bluesky", "email", "manual"]),
  name:    z.string().min(1).max(100).describe("Human-readable label for this source"),
  url:     z.string().optional().describe("Feed URL (rss) or Bluesky DID/handle (bluesky)"),
  enabled: z.boolean().default(true),
});

export const ListSourcesInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("add"),    source: SourceSchema }),
  z.object({ action: z.literal("remove"), source_id: z.string().describe("Source ID to remove") }),
  z.object({ action: z.literal("toggle"), source_id: z.string(), enabled: z.boolean() }),
]);

export type ListSourcesInput = z.infer<typeof ListSourcesInput>;

export interface SourceRow {
  id:          string;
  type:        string;
  name:        string;
  url:         string | null;
  enabled:     boolean;
  last_polled: string | null;
  created_at:  string;
  article_count?: number;
}

export interface ListSourcesOutput {
  action:  string;
  sources: SourceRow[];
  total:   number;
  message?: string;
}

interface DbSourceRow {
  id: string; type: string; name: string; url: string | null;
  enabled: number; last_polled: string | null; created_at: string;
}

export async function listSources(
  input: ListSourcesInput,
  env:   Env,
): Promise<ListSourcesOutput> {

  if (input.action === "list") {
    const result = await env.CONTENT_DB
      .prepare(`
        SELECT
          s.*,
          COUNT(a.id) as article_count
        FROM sources s
        LEFT JOIN articles a ON a.source_id = s.id
        GROUP BY s.id
        ORDER BY s.created_at DESC
      `)
      .all<DbSourceRow & { article_count: number }>();

    const sources: SourceRow[] = result.results.map((r) => ({
      id:           r.id,
      type:         r.type,
      name:         r.name,
      url:          r.url,
      enabled:      r.enabled === 1,
      last_polled:  r.last_polled,
      created_at:   r.created_at,
      article_count: r.article_count,
    }));

    return { action: "list", sources, total: sources.length };
  }

  if (input.action === "add") {
    const { source } = input;
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.CONTENT_DB
      .prepare(`
        INSERT INTO sources (id, type, name, url, enabled, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `)
      .bind(id, source.type, source.name, source.url ?? null, source.enabled ? 1 : 0, now)
      .run();

    const row = await env.CONTENT_DB
      .prepare("SELECT * FROM sources WHERE id = ?")
      .bind(id)
      .first<DbSourceRow>();

    const sources: SourceRow[] = row
      ? [{ id: row.id, type: row.type, name: row.name, url: row.url, enabled: row.enabled === 1, last_polled: row.last_polled, created_at: row.created_at, article_count: 0 }]
      : [];

    return { action: "add", sources, total: sources.length, message: `Source "${source.name}" added with ID ${id}` };
  }

  if (input.action === "remove") {
    const existing = await env.CONTENT_DB
      .prepare("SELECT id, name FROM sources WHERE id = ?")
      .bind(input.source_id)
      .first<{ id: string; name: string }>();

    if (!existing) throw new Error(`Source not found: ${input.source_id}`);

    await env.CONTENT_DB
      .prepare("DELETE FROM sources WHERE id = ?")
      .bind(input.source_id)
      .run();

    return { action: "remove", sources: [], total: 0, message: `Source "${existing.name}" removed` };
  }

  // action === "toggle"
  await env.CONTENT_DB
    .prepare("UPDATE sources SET enabled = ?1 WHERE id = ?2")
    .bind(input.enabled ? 1 : 0, input.source_id)
    .run();

  const updated = await env.CONTENT_DB
    .prepare("SELECT * FROM sources WHERE id = ?")
    .bind(input.source_id)
    .first<DbSourceRow>();

  if (!updated) throw new Error(`Source not found: ${input.source_id}`);

  const sources: SourceRow[] = [{
    id: updated.id, type: updated.type, name: updated.name, url: updated.url,
    enabled: updated.enabled === 1, last_polled: updated.last_polled, created_at: updated.created_at,
  }];

  return { action: "toggle", sources, total: 1, message: `Source "${updated.name}" ${input.enabled ? "enabled" : "disabled"}` };
}
