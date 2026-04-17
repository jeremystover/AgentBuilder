import { z } from "zod";
import type { Env } from "../../types";
import {
  articleQueries,
  attachmentQueries,
  articleCategoryQueries,
} from "../../lib/db";
import { storeAttachment, getAttachmentKey } from "../../lib/storage";
import { upsertVector } from "../../lib/vectors";
import { extractTextFromImage, isImageMime, isTextMime, isAllowedMime, mimeFromFilename } from "../../lib/ocr";
import { autoAssignCategories } from "../../lib/categorize";

export const UploadFileInput = z.object({
  content_base64: z.string().min(1).describe("Base64-encoded file content"),
  filename:       z.string().min(1).max(255).describe("Original filename with extension"),
  mime_type:      z.string().optional().describe("MIME type — auto-detected from filename if omitted"),
  article_id:     z.string().uuid().optional().describe("Link to an existing article"),
  category_ids:   z.array(z.string().uuid()).optional().describe("Category IDs to tag this file with"),
  note:           z.string().max(500).optional().describe("Note about this file"),
});

export type UploadFileInput = z.infer<typeof UploadFileInput>;

export interface UploadFileOutput {
  attachment_id:  string;
  r2_key:         string;
  filename:       string;
  mime_type:      string;
  file_size:      number;
  ocr_text:       string | null;
  is_text_image:  boolean;
  article_id:     string | null;
  created_article_id: string | null;
  categories:     string[];
}

const MAX_FILE_SIZE     = 10 * 1024 * 1024; // 10 MB
const SUMMARY_MODEL     = "@cf/meta/llama-3.1-8b-instruct" as const;
const EMBED_MODEL       = "@cf/baai/bge-base-en-v1.5" as const;
const MAX_EMBED_CHARS   = 8_000;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

async function createArticleFromText(
  env: Env,
  text: string,
  source: { attachmentId: string; filename: string; note?: string },
): Promise<string> {
  const articleId = crypto.randomUUID();
  const now = new Date().toISOString();
  const syntheticUrl = `attachment://${source.attachmentId}`;

  let summary = "";
  let topics: string[] = [];
  if (text.length > 50) {
    try {
      const prompt = `You are a precise content analyst. Given the text below, respond with ONLY valid JSON.\n\nText: ${truncate(text, MAX_EMBED_CHARS)}\n\nRespond with exactly:\n{"summary": "<2-3 sentence summary>", "topics": ["<topic1>", "<topic2>"]}\n\nOutput ONLY the JSON object, nothing else.`;
      const response = await env.AI.run(SUMMARY_MODEL, {
        messages: [
          { role: "system", content: "You are a JSON-only content analysis API." },
          { role: "user", content: prompt },
        ],
        max_tokens: 400,
        temperature: 0.2,
      });
      const raw = response.response.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      const parsed = JSON.parse(raw) as { summary?: string; topics?: unknown[] };
      summary = typeof parsed.summary === "string" ? parsed.summary : "";
      topics = Array.isArray(parsed.topics) ? (parsed.topics as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 6) : [];
    } catch {
      // Non-fatal
    }
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const readingTimeMin = Math.max(1, Math.round(wordCount / 238));

  await articleQueries.upsertReady(env.CONTENT_DB, {
    id: articleId,
    source_id: null,
    url: syntheticUrl,
    canonical_url: null,
    title: source.note ?? source.filename,
    author: null,
    published_at: null,
    ingested_at: now,
    summary: summary || null,
    full_text: text.length <= 50_000 ? text : null,
    html: null,
    word_count: wordCount,
    reading_time_min: readingTimeMin,
    topics: JSON.stringify(topics),
    r2_key: null,
    vector_id: articleId,
    status: "ready",
  });

  // Embed
  try {
    const embedInput = truncate(
      [
        source.note ? `Title: ${source.note}` : `File: ${source.filename}`,
        summary ? `Summary: ${summary}` : null,
        `Content: ${text}`,
      ].filter(Boolean).join("\n\n"),
      MAX_EMBED_CHARS,
    );
    const embedResponse = await env.AI.run(EMBED_MODEL, { text: [embedInput] });
    const vector = embedResponse.data[0];
    if (vector) {
      await upsertVector(env.CONTENT_VECTORS, {
        id: articleId,
        values: vector,
        metadata: { url: syntheticUrl, title: source.note ?? source.filename, topics: topics.join(","), ingested: now, source_id: "" },
      });
    }
  } catch (err) {
    console.warn("[upload_file] Embedding failed:", err);
  }

  return articleId;
}

export async function uploadFile(
  input: UploadFileInput,
  env: Env,
): Promise<UploadFileOutput> {
  const mimeType = input.mime_type ?? mimeFromFilename(input.filename);
  if (!isAllowedMime(mimeType)) {
    throw new Error(`Unsupported file type: ${mimeType}. Allowed: png, jpg, webp, gif, pdf, txt, md, csv`);
  }

  const bytes = Uint8Array.from(atob(input.content_base64), (c) => c.charCodeAt(0));
  if (bytes.length > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${(bytes.length / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`);
  }

  const attachmentId = crypto.randomUUID();
  const r2Key = getAttachmentKey(attachmentId, input.filename);

  // Store in R2
  await storeAttachment(env.CONTENT_STORE, r2Key, bytes.buffer as ArrayBuffer, mimeType);

  // Create DB record
  await attachmentQueries.create(env.CONTENT_DB, {
    id: attachmentId,
    article_id: input.article_id,
    filename: input.filename,
    mime_type: mimeType,
    file_size: bytes.length,
    r2_key: r2Key,
  });

  let ocrText: string | null = null;
  let isTextImage = false;
  let createdArticleId: string | null = null;
  let linkedArticleId = input.article_id ?? null;

  if (isImageMime(mimeType)) {
    // OCR pipeline
    try {
      const ocrResult = await extractTextFromImage(env.AI, bytes, mimeType);
      ocrText = ocrResult.text || null;
      isTextImage = ocrResult.isTextImage;

      if (ocrText) {
        // Embed OCR text for search
        let vectorId: string | undefined;
        try {
          const embedResponse = await env.AI.run(EMBED_MODEL, { text: [truncate(ocrText, MAX_EMBED_CHARS)] });
          const vector = embedResponse.data[0];
          if (vector) {
            vectorId = `att-${attachmentId}`;
            await upsertVector(env.CONTENT_VECTORS, {
              id: vectorId,
              values: vector,
              metadata: { url: `attachment://${attachmentId}`, title: input.filename, topics: "", ingested: new Date().toISOString(), source_id: "" },
            });
          }
        } catch {
          // Non-fatal
        }

        await attachmentQueries.updateOcr(env.CONTENT_DB, attachmentId, ocrText, isTextImage, vectorId);

        // Auto-create article from text-heavy images
        if (isTextImage && !input.article_id) {
          createdArticleId = await createArticleFromText(env, ocrText, { attachmentId, filename: input.filename, note: input.note });
          await attachmentQueries.linkToArticle(env.CONTENT_DB, attachmentId, createdArticleId);
          linkedArticleId = createdArticleId;
        }
      }
    } catch (err) {
      console.warn("[upload_file] OCR failed:", err);
    }
  } else if (isTextMime(mimeType)) {
    // Directly read text content
    const textContent = new TextDecoder().decode(bytes);
    if (textContent.length > 0 && !input.article_id) {
      createdArticleId = await createArticleFromText(env, textContent, { attachmentId, filename: input.filename, note: input.note });
      await attachmentQueries.linkToArticle(env.CONTENT_DB, attachmentId, createdArticleId);
      linkedArticleId = createdArticleId;
    }
  }

  // Auto-categorize the created article
  const assignedCategories: string[] = [];
  if (createdArticleId) {
    if (input.category_ids?.length) {
      await articleCategoryQueries.bulkAssign(env.CONTENT_DB, createdArticleId, input.category_ids, "manual");
      assignedCategories.push(...input.category_ids);
    } else {
      const article = await articleQueries.findById(env.CONTENT_DB, createdArticleId);
      if (article) {
        const topics: string[] = article.topics ? JSON.parse(article.topics) : [];
        const autoIds = await autoAssignCategories(env.CONTENT_DB, env.AI, createdArticleId, {
          title: article.title, summary: article.summary, topics,
        });
        assignedCategories.push(...autoIds);
      }
    }
  } else if (input.article_id && input.category_ids?.length) {
    await articleCategoryQueries.bulkAssign(env.CONTENT_DB, input.article_id, input.category_ids, "manual");
    assignedCategories.push(...input.category_ids);
  }

  return {
    attachment_id: attachmentId,
    r2_key: r2Key,
    filename: input.filename,
    mime_type: mimeType,
    file_size: bytes.length,
    ocr_text: ocrText,
    is_text_image: isTextImage,
    article_id: linkedArticleId,
    created_article_id: createdArticleId,
    categories: assignedCategories,
  };
}
