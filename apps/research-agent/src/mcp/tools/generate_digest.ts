/**
 * generate_digest — Curation tool
 *
 * Builds an on-demand ranked digest from recent unread articles.
 * Steps:
 *   1. Fetch articles ingested since `since` (default: last 24h)
 *   2. Score each article against interest profile
 *   3. Rank by combined score
 *   4. Group by topic cluster
 *   5. Return top-N with summaries, scores, and source links
 */

import { z } from "zod";
import type { Env } from "../../types";
import { articleQueries, articleCategoryQueries } from "../../lib/db";
import { scoreContent } from "./score_content";

export const GenerateDigestInput = z.object({
  limit: z
    .number().int().min(1).max(50).default(15)
    .describe("Maximum number of articles to include"),
  since: z
    .string().optional()
    .describe("ISO-8601 timestamp — only include articles ingested after this. Defaults to 24h ago."),
  topic: z
    .string().optional()
    .describe("Filter digest to a specific topic (partial match)"),
  min_score: z
    .number().min(0).max(1).default(0.0)
    .describe("Minimum relevance score to include (0 = no filter)"),
  category_id: z
    .string().uuid().optional()
    .describe("Filter digest to articles in this category"),
});

export type GenerateDigestInput = z.infer<typeof GenerateDigestInput>;

export interface DigestItem {
  article_id:       string;
  rank:             number;
  score:            number;
  title:            string | null;
  url:              string;
  author:           string | null;
  summary:          string | null;
  topics:           string[];
  published_at:     string | null;
  ingested_at:      string;
  reading_time_min: number | null;
  source_id:        string | null;
  categories:       string[];
}

export interface DigestSection {
  topic:    string;
  items:    DigestItem[];
}

export interface GenerateDigestOutput {
  generated_at:  string;
  since:         string;
  total_fetched: number;
  total_scored:  number;
  sections:      DigestSection[];
  items:         DigestItem[];   // flat ranked list (same articles, no grouping)
}

export async function generateDigest(
  input: GenerateDigestInput,
  env:   Env,
): Promise<GenerateDigestOutput> {
  const now      = new Date().toISOString();
  const sinceTs  = input.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // 1. Fetch recent ready articles
  const rows = await env.CONTENT_DB
    .prepare(`
      SELECT * FROM articles
      WHERE status = 'ready'
        AND ingested_at >= ?1
        ${input.topic ? "AND topics LIKE ?2" : ""}
      ORDER BY ingested_at DESC
      LIMIT 200
    `)
    .bind(
      sinceTs,
      ...(input.topic ? [`%${input.topic}%`] : []),
    )
    .all<Awaited<ReturnType<typeof articleQueries.findById>>>();

  let allRows = rows.results.filter((r): r is NonNullable<typeof r> => r !== null);

  // Filter by category if specified
  if (input.category_id) {
    const filtered = [];
    for (const row of allRows) {
      const cats = await articleCategoryQueries.listForArticle(env.CONTENT_DB, row.id);
      if (cats.some((c) => c.id === input.category_id)) filtered.push(row);
    }
    allRows = filtered;
  }

  const totalFetched = allRows.length;

  if (totalFetched === 0) {
    return { generated_at: now, since: sinceTs, total_fetched: 0, total_scored: 0, sections: [], items: [] };
  }

  // 2. Score each article
  const scored: Array<{ row: NonNullable<typeof allRows[0]>; score: number }> = [];

  for (const row of allRows) {
    try {
      const result = await scoreContent({ article_id: row.id }, env);
      if (result.score >= input.min_score) {
        scored.push({ row, score: result.score });
      }
    } catch {
      // Non-fatal — include with score 0 so it still appears
      scored.push({ row, score: 0 });
    }
  }

  // 3. Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, input.limit);

  // 4. Build flat item list
  const items: DigestItem[] = [];
  for (const [idx, { row, score }] of top.entries()) {
    const cats = await articleCategoryQueries.listForArticle(env.CONTENT_DB, row.id);
    items.push({
      article_id:       row.id,
      rank:             idx + 1,
      score:            Math.round(score * 10_000) / 10_000,
      title:            row.title            ?? null,
      url:              row.url,
      author:           row.author           ?? null,
      summary:          row.summary          ?? null,
      topics:           row.topics ? JSON.parse(row.topics) : [],
      published_at:     row.published_at     ?? null,
      ingested_at:      row.ingested_at,
      reading_time_min: row.reading_time_min ?? null,
      source_id:        row.source_id        ?? null,
      categories:       cats.map((c) => c.name),
    });
  }

  // 5. Group into topic sections
  const topicMap = new Map<string, DigestItem[]>();
  for (const item of items) {
    const primaryTopic = item.topics[0] ?? "Uncategorised";
    if (!topicMap.has(primaryTopic)) topicMap.set(primaryTopic, []);
    topicMap.get(primaryTopic)!.push(item);
  }

  const sections: DigestSection[] = [...topicMap.entries()]
    .map(([topic, sectionItems]) => ({ topic, items: sectionItems }))
    .sort((a, b) => b.items[0]!.score - a.items[0]!.score); // sort sections by top item score

  return {
    generated_at:  now,
    since:         sinceTs,
    total_fetched: totalFetched,
    total_scored:  scored.length,
    sections,
    items,
  };
}
