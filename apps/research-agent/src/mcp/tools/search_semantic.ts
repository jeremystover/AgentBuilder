import { z } from "zod";
import type { Env } from "../../types";
import { queryVectors } from "../../lib/vectors";
import { articleQueries } from "../../lib/db";
import type { ArticleRow } from "../../lib/db";

export const SearchSemanticInput = z.object({
  query:     z.string().min(1).max(1000).describe("Natural language search query"),
  top_k:     z.number().int().min(1).max(50).default(10).describe("Number of results to return"),
  min_score: z.number().min(0).max(1).default(0.5).describe("Minimum cosine similarity score"),
  filter:    z.object({ source_id: z.string().optional(), topic: z.string().optional() }).optional(),
});

export type SearchSemanticInput = z.infer<typeof SearchSemanticInput>;

export interface SemanticResult {
  article_id:       string;
  score:            number;
  url:              string;
  title:            string | null;
  author:           string | null;
  summary:          string | null;
  topics:           string[];
  published_at:     string | null;
  ingested_at:      string;
  reading_time_min: number | null;
}

export interface SearchSemanticOutput {
  query:   string;
  results: SemanticResult[];
  total:   number;
}

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5" as const;

export async function searchSemantic(input: SearchSemanticInput, env: Env): Promise<SearchSemanticOutput> {
  const embedResponse = await env.AI.run(EMBED_MODEL, { text: [input.query] });
  const queryVector = embedResponse.data[0];
  if (!queryVector) throw new Error("Embedding model returned no vector for query");

  const vectorFilter: Record<string, string> = {};
  if (input.filter?.source_id) vectorFilter["source_id"] = input.filter.source_id;

  const matches = await queryVectors(env.CONTENT_VECTORS, queryVector, {
    topK: input.top_k,
    // Conditionally include filter — exactOptionalPropertyTypes disallows passing undefined
    ...(Object.keys(vectorFilter).length ? { filter: vectorFilter } : {}),
    returnMetadata: true,
  });

  const aboveThreshold = matches.filter((m) => m.score >= input.min_score);
  if (aboveThreshold.length === 0) return { query: input.query, results: [], total: 0 };

  const ids       = aboveThreshold.map((m) => m.id);
  const articleRows = await articleQueries.fetchIdsIn(env.CONTENT_DB, ids);
  const rowById   = new Map<string, ArticleRow>(articleRows.map((r) => [r.id, r]));

  const results: SemanticResult[] = [];
  for (const match of aboveThreshold) {
    const row = rowById.get(match.id);
    if (!row || row.status !== "ready") continue;

    if (input.filter?.topic) {
      const topics: string[] = row.topics ? JSON.parse(row.topics) : [];
      const topicLower = input.filter.topic.toLowerCase();
      if (!topics.some((t) => t.toLowerCase().includes(topicLower))) continue;
    }

    results.push({
      article_id:       row.id,
      score:            Math.round(match.score * 10_000) / 10_000,
      url:              row.url,
      title:            row.title            ?? null,
      author:           row.author           ?? null,
      summary:          row.summary          ?? null,
      topics:           row.topics ? JSON.parse(row.topics) : [],
      published_at:     row.published_at     ?? null,
      ingested_at:      row.ingested_at,
      reading_time_min: row.reading_time_min ?? null,
    });
  }

  return { query: input.query, results, total: results.length };
}
