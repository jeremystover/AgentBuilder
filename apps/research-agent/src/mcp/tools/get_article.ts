import { z } from "zod";
import type { Env } from "../../types";
import { articleQueries, articleCategoryQueries } from "../../lib/db";
import { getObject, getTextKey } from "../../lib/storage";

export const GetArticleInput = z.object({
  article_id:        z.string().uuid().describe("Article UUID from a prior search result"),
  include_full_text: z.boolean().default(false).describe("Include full extracted text body"),
  include_html:      z.boolean().default(false).describe("Include raw HTML"),
});

export type GetArticleInput = z.infer<typeof GetArticleInput>;

export interface GetArticleOutput {
  article_id:       string;
  url:              string;
  canonical_url:    string | null;
  title:            string | null;
  author:           string | null;
  summary:          string | null;
  topics:           string[];
  published_at:     string | null;
  ingested_at:      string;
  word_count:       number | null;
  reading_time_min: number | null;
  language:         string | null;
  source_id:        string | null;
  status:           string;
  categories:       string[];
  full_text?:       string | null;
  html?:            string | null;
  error_message?:   string | null;
}

export async function getArticle(input: GetArticleInput, env: Env): Promise<GetArticleOutput> {
  const row = await articleQueries.findById(env.CONTENT_DB, input.article_id);
  if (!row) throw new Error(`Article not found: ${input.article_id}`);

  const cats = await articleCategoryQueries.listForArticle(env.CONTENT_DB, input.article_id);

  const output: GetArticleOutput = {
    article_id:       row.id,
    url:              row.url,
    canonical_url:    row.canonical_url    ?? null,
    title:            row.title            ?? null,
    author:           row.author           ?? null,
    summary:          row.summary          ?? null,
    topics:           row.topics ? JSON.parse(row.topics) : [],
    published_at:     row.published_at     ?? null,
    ingested_at:      row.ingested_at,
    word_count:       row.word_count       ?? null,
    reading_time_min: row.reading_time_min ?? null,
    language:         row.language         ?? null,
    source_id:        row.source_id        ?? null,
    status:           row.status,
    categories:       cats.map((c) => c.name),
    error_message:    row.error_message    ?? null,
  };

  if (input.include_full_text) {
    if (row.full_text) {
      output.full_text = row.full_text;
    } else if (row.r2_key) {
      const textKey = getTextKey(row.id);
      output.full_text = await getObject(env.CONTENT_STORE, textKey)
        ?? await getObject(env.CONTENT_STORE, row.r2_key);
    } else {
      output.full_text = null;
    }
  }

  if (input.include_html) {
    if (row.html) {
      output.html = row.html;
    } else if (row.r2_key) {
      output.html = await getObject(env.CONTENT_STORE, row.r2_key);
    } else {
      output.html = null;
    }
  }

  return output;
}
