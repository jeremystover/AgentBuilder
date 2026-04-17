import { z } from "zod";
import type { Env } from "../../types";
import { articleQueries, articleCategoryQueries } from "../../lib/db";
import { upsertVector } from "../../lib/vectors";
import { storeHTML, getHTMLKey } from "../../lib/storage";
import { extractContent } from "../../lib/extract";
import { autoAssignCategories } from "../../lib/categorize";

export const IngestUrlInput = z.object({
  url:            z.string().url().describe("The fully-qualified URL to ingest"),
  source_id:      z.string().optional().describe("Optional source ID to associate"),
  force_reingest: z.boolean().default(false).describe("Re-process even if previously ingested"),
  note:           z.string().max(500).optional().describe("Optional note about why this was saved"),
  category_ids:   z.array(z.string().uuid()).optional().describe("Category IDs to tag this article with"),
});

export type IngestUrlInput = z.infer<typeof IngestUrlInput>;

export interface IngestUrlOutput {
  article_id:       string;
  url:              string;
  canonical_url:    string | null;
  title:            string | null;
  author:           string | null;
  summary:          string | null;
  topics:           string[];
  word_count:       number | null;
  reading_time_min: number | null;
  already_existed:  boolean;
  categories:       string[];
  status:           "ready" | "error";
  error?:           string;
}

const R2_INLINE_THRESHOLD_BYTES = 50_000;
const SUMMARY_MODEL             = "@cf/meta/llama-3.1-8b-instruct" as const;
const EMBED_MODEL               = "@cf/baai/bge-base-en-v1.5" as const;
const MAX_EMBED_CHARS           = 8_000;
const WORDS_PER_MINUTE          = 238;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function buildEmbedInput(title: string | null, summary: string | null, fullText: string): string {
  return truncate(
    [title ? `Title: ${title}` : null, summary ? `Summary: ${summary}` : null, `Content: ${fullText}`]
      .filter(Boolean).join("\n\n"),
    MAX_EMBED_CHARS,
  );
}

async function analyseWithAI(env: Env, title: string | null, fullText: string) {
  const prompt = `You are a precise content analyst. Given the article below, respond with ONLY valid JSON.

Article title: ${title ?? "(unknown)"}
Article text: ${truncate(fullText, MAX_EMBED_CHARS)}

Respond with exactly:
{"summary": "<2-3 sentence summary>", "topics": ["<topic1>", "<topic2>"]}

Output ONLY the JSON object, nothing else.`;

  const response = await env.AI.run(SUMMARY_MODEL, {
    messages: [
      { role: "system", content: "You are a JSON-only content analysis API." },
      { role: "user", content: prompt },
    ],
    max_tokens: 400,
    temperature: 0.2,
  });

  const raw = response.response.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    const parsed = JSON.parse(raw) as { summary?: string; topics?: unknown[] };
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      topics: Array.isArray(parsed.topics)
        ? (parsed.topics as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 6)
        : [],
    };
  } catch {
    console.warn("[ingest_url] AI JSON parse failed:", raw);
    return { summary: "", topics: [] };
  }
}

async function embedText(env: Env, text: string): Promise<number[]> {
  const response = await env.AI.run(EMBED_MODEL, { text: [truncate(text, MAX_EMBED_CHARS)] });
  const data = response.data;
  if (!data?.[0]) throw new Error("Embedding model returned no vector");
  return data[0];
}

export async function ingestUrl(
  input: IngestUrlInput,
  env: Env,
  ctx: ExecutionContext,
): Promise<IngestUrlOutput> {
  const { url, source_id, force_reingest, category_ids } = input;

  // Deduplication check
  const existing = await articleQueries.findByUrl(env.CONTENT_DB, url);
  if (existing && !force_reingest) {
    const existingCats = await articleCategoryQueries.listForArticle(env.CONTENT_DB, existing.id);
    return {
      article_id: existing.id, url: existing.url,
      canonical_url: existing.canonical_url ?? null,
      title: existing.title ?? null, author: existing.author ?? null,
      summary: existing.summary ?? null,
      topics: existing.topics ? JSON.parse(existing.topics) : [],
      word_count: existing.word_count ?? null,
      reading_time_min: existing.reading_time_min ?? null,
      already_existed: true, categories: existingCats.map((c) => c.id),
      status: existing.status === "ready" ? "ready" : "error",
    };
  }

  const articleId = existing?.id ?? crypto.randomUUID();

  // Fetch & extract
  let extracted: Awaited<ReturnType<typeof extractContent>>;
  try {
    extracted = await extractContent(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await articleQueries.upsertError(env.CONTENT_DB, { id: articleId, url, source_id: source_id ?? null, error: `fetch/extract failed: ${message}` });
    return { article_id: articleId, url, canonical_url: null, title: null, author: null, summary: null, topics: [], word_count: null, reading_time_min: null, already_existed: false, categories: [], status: "error", error: message };
  }

  const { title, author, publishedAt, fullText, html, canonicalUrl } = extracted;
  const wordCount      = countWords(fullText);
  const readingTimeMin = Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));

  // AI analysis
  let summary = "", topics: string[] = [];
  if (fullText.length > 50) {
    try { ({ summary, topics } = await analyseWithAI(env, title, fullText)); }
    catch (err) { console.warn("[ingest_url] AI analysis failed:", err); }
  }

  // Embed
  let vector: number[] | null = null;
  try { vector = await embedText(env, buildEmbedInput(title, summary, fullText)); }
  catch (err) { console.warn("[ingest_url] Embedding failed:", err); }

  // R2 storage for large HTML
  let r2Key: string | null = null;
  const htmlBytes = new TextEncoder().encode(html).length;
  if (htmlBytes > R2_INLINE_THRESHOLD_BYTES) {
    try { r2Key = getHTMLKey(articleId); await storeHTML(env.CONTENT_STORE, r2Key, html); }
    catch (err) { console.warn("[ingest_url] R2 store failed:", err); r2Key = null; }
  }

  const now = new Date().toISOString();

  await articleQueries.upsertReady(env.CONTENT_DB, {
    id: articleId, source_id: source_id ?? null, url,
    canonical_url: canonicalUrl ?? null, title: title ?? null,
    author: author ?? null, published_at: publishedAt ?? null,
    ingested_at: now, summary: summary || null,
    full_text: htmlBytes <= R2_INLINE_THRESHOLD_BYTES ? fullText : null,
    html: htmlBytes <= R2_INLINE_THRESHOLD_BYTES ? html : null,
    word_count: wordCount, reading_time_min: readingTimeMin,
    topics: JSON.stringify(topics), r2_key: r2Key,
    vector_id: vector ? articleId : null, status: "ready",
  });

  if (vector) {
    const upsertPromise = upsertVector(env.CONTENT_VECTORS, {
      id: articleId, values: vector,
      metadata: { url, title: title ?? "", topics: topics.join(","), ingested: now, source_id: source_id ?? "" },
    }).catch((err) => console.warn("[ingest_url] Vectorize upsert failed:", err));
    if (typeof ctx?.waitUntil === "function") ctx.waitUntil(upsertPromise);
    else await upsertPromise;
  }

  // Assign categories
  const assignedCategories: string[] = [];
  if (category_ids?.length) {
    await articleCategoryQueries.bulkAssign(env.CONTENT_DB, articleId, category_ids, "manual");
    assignedCategories.push(...category_ids);
  } else {
    try {
      const autoIds = await autoAssignCategories(env.CONTENT_DB, env.AI, articleId, { title, summary, topics });
      assignedCategories.push(...autoIds);
    } catch (err) {
      console.warn("[ingest_url] Auto-categorization failed:", err);
    }
  }

  return {
    article_id: articleId, url, canonical_url: canonicalUrl ?? null,
    title: title ?? null, author: author ?? null, summary: summary || null,
    topics, word_count: wordCount, reading_time_min: readingTimeMin,
    already_existed: false, categories: assignedCategories, status: "ready",
  };
}
