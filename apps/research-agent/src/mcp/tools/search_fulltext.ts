import { z } from "zod";
import type { Env } from "../../types";
import { articleQueries, articleCategoryQueries } from "../../lib/db";

export const SearchFulltextInput = z.object({
  query:       z.string().min(1).max(500).describe('Keyword query — supports FTS5 operators (AND, OR, NOT, "phrase")'),
  limit:       z.number().int().min(1).max(50).default(20),
  offset:      z.number().int().min(0).default(0),
  category_id: z.string().uuid().optional().describe("Filter results to this category"),
});

export type SearchFulltextInput = z.infer<typeof SearchFulltextInput>;

export interface FulltextResult {
  article_id:       string;
  url:              string;
  title:            string | null;
  author:           string | null;
  summary:          string | null;
  topics:           string[];
  published_at:     string | null;
  ingested_at:      string;
  reading_time_min: number | null;
  categories:       string[];
}

export interface SearchFulltextOutput {
  query:   string;
  results: FulltextResult[];
  total:   number;
  offset:  number;
}

function sanitiseFtsQuery(raw: string): string {
  let q = raw.replace(/\s+/g, " ").trim();
  const hasFtsOps = /\b(AND|OR|NOT)\b|"/.test(q);
  if (hasFtsOps) return q.replace(/[;(){}\[\]]/g, " ").trim();
  return q.replace(/[^a-zA-Z0-9 '\-]/g, " ").replace(/\s+/g, " ").trim();
}

export async function searchFulltext(input: SearchFulltextInput, env: Env): Promise<SearchFulltextOutput> {
  const sanitised = sanitiseFtsQuery(input.query);
  if (!sanitised) return { query: input.query, results: [], total: 0, offset: input.offset };

  const rows = await articleQueries.fullTextSearch(env.CONTENT_DB, sanitised, input.limit, input.offset);

  let filteredRows = rows;
  if (input.category_id) {
    const filtered = [];
    for (const row of rows) {
      const cats = await articleCategoryQueries.listForArticle(env.CONTENT_DB, row.id);
      if (cats.some((c) => c.id === input.category_id)) filtered.push(row);
    }
    filteredRows = filtered;
  }

  const results: FulltextResult[] = [];
  for (const row of filteredRows) {
    const cats = await articleCategoryQueries.listForArticle(env.CONTENT_DB, row.id);
    results.push({
      article_id:       row.id,
      url:              row.url,
      title:            row.title            ?? null,
      author:           row.author           ?? null,
      summary:          row.summary          ?? null,
      topics:           row.topics ? JSON.parse(row.topics) : [],
      published_at:     row.published_at     ?? null,
      ingested_at:      row.ingested_at,
      reading_time_min: row.reading_time_min ?? null,
      categories:       cats.map((c) => c.name),
    });
  }

  return { query: input.query, results, total: results.length, offset: input.offset };
}
