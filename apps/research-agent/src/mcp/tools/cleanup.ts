import { z } from "zod";
import type { Env } from "../../types";
import {
  articleQueries,
  attachmentQueries,
  articleCategoryQueries,
  cleanupLogQueries,
} from "../../lib/db";
import type { ArticleRow, CleanupLogRow } from "../../lib/db";
import { deleteObject, getHTMLKey, getTextKey, listR2Keys } from "../../lib/storage";
import { deleteVector } from "../../lib/vectors";

export const CleanupInput = z.discriminatedUnion("action", [
  z.object({
    action:     z.literal("delete_article"),
    article_id: z.string().uuid().describe("Article to permanently delete with all related data"),
  }),
  z.object({
    action:     z.literal("delete_attachment"),
    attachment_id: z.string().uuid().describe("Attachment to permanently delete"),
  }),
  z.object({
    action: z.literal("analyze"),
    scope:  z.enum(["all", "duplicates", "stale", "errors", "orphans", "uncategorized"])
      .default("all")
      .describe("What to scan for"),
  }),
  z.object({
    action: z.literal("review"),
    batch_id: z.string().optional().describe("Filter to a specific analysis batch"),
  }),
  z.object({
    action: z.literal("approve"),
    ids:    z.array(z.string().uuid()).min(1).describe("Suggestion IDs to approve"),
  }),
  z.object({
    action: z.literal("reject"),
    ids:    z.array(z.string().uuid()).min(1).describe("Suggestion IDs to reject"),
  }),
  z.object({
    action: z.literal("execute"),
  }),
]);

export type CleanupInput = z.infer<typeof CleanupInput>;

export interface CleanupOutput {
  action:      string;
  message:     string;
  deleted?:    { article_id: string; title: string | null };
  suggestions?: CleanupLogRow[];
  executed?:   number;
  batch_id?:   string;
}

async function cascadeDeleteArticle(env: Env, articleId: string): Promise<void> {
  const article = await articleQueries.findById(env.CONTENT_DB, articleId);
  if (!article) return;

  // Delete attachments and their R2 + vectors
  const attachments = await attachmentQueries.listForArticle(env.CONTENT_DB, articleId);
  for (const att of attachments) {
    try { await deleteObject(env.CONTENT_STORE, att.r2_key); } catch { /* best effort */ }
    if (att.vector_id) {
      try { await deleteVector(env.CONTENT_VECTORS, att.vector_id); } catch { /* best effort */ }
    }
    await attachmentQueries.delete(env.CONTENT_DB, att.id);
  }

  // Delete R2 objects for article HTML/text
  try { await deleteObject(env.CONTENT_STORE, getHTMLKey(articleId)); } catch { /* may not exist */ }
  try { await deleteObject(env.CONTENT_STORE, getTextKey(articleId)); } catch { /* may not exist */ }
  if (article.r2_key) {
    try { await deleteObject(env.CONTENT_STORE, article.r2_key); } catch { /* best effort */ }
  }

  // Delete vector
  if (article.vector_id) {
    try { await deleteVector(env.CONTENT_VECTORS, article.vector_id); } catch { /* best effort */ }
  }

  // Delete category tags (cascade handles this but be explicit)
  await articleCategoryQueries.deleteAllForArticle(env.CONTENT_DB, articleId);

  // Delete article row (cascades to feedback + article_categories via FK)
  await articleQueries.delete(env.CONTENT_DB, articleId);
}

async function cascadeDeleteAttachment(env: Env, attachmentId: string): Promise<void> {
  const att = await attachmentQueries.findById(env.CONTENT_DB, attachmentId);
  if (!att) return;

  try { await deleteObject(env.CONTENT_STORE, att.r2_key); } catch { /* best effort */ }
  if (att.vector_id) {
    try { await deleteVector(env.CONTENT_VECTORS, att.vector_id); } catch { /* best effort */ }
  }
  await attachmentQueries.delete(env.CONTENT_DB, attachmentId);
}

// ── Analysis routines ─────────────────────────────────────────

async function findDuplicates(env: Env, batchId: string): Promise<number> {
  const articles = await articleQueries.listRecent(env.CONTENT_DB, { limit: 500, status: "ready" });
  const urlMap = new Map<string, ArticleRow[]>();
  let count = 0;

  for (const article of articles) {
    const normalized = article.url
      .replace(/\/$/, "")
      .replace(/^https?:\/\/(www\.)?/, "")
      .replace(/[?#].*$/, "")
      .toLowerCase();

    if (!urlMap.has(normalized)) urlMap.set(normalized, []);
    urlMap.get(normalized)!.push(article);
  }

  for (const [, group] of urlMap) {
    if (group.length < 2) continue;
    // Keep the newest, flag the rest
    group.sort((a, b) => b.ingested_at.localeCompare(a.ingested_at));
    for (let i = 1; i < group.length; i++) {
      const dupe = group[i]!;
      await cleanupLogQueries.insert(env.CONTENT_DB, {
        action: "delete",
        target_type: "article",
        target_id: dupe.id,
        reason: `Duplicate of ${group[0]!.id} (same normalized URL)`,
        details: JSON.stringify({ title: dupe.title, url: dupe.url, kept_id: group[0]!.id }),
        batch_id: batchId,
      });
      count++;
    }
  }

  // Title similarity check for different URLs
  const titleMap = new Map<string, ArticleRow[]>();
  for (const article of articles) {
    if (!article.title) continue;
    const normalizedTitle = article.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (normalizedTitle.length < 10) continue;
    if (!titleMap.has(normalizedTitle)) titleMap.set(normalizedTitle, []);
    titleMap.get(normalizedTitle)!.push(article);
  }

  for (const [, group] of titleMap) {
    if (group.length < 2) continue;
    group.sort((a, b) => b.ingested_at.localeCompare(a.ingested_at));
    for (let i = 1; i < group.length; i++) {
      const dupe = group[i]!;
      await cleanupLogQueries.insert(env.CONTENT_DB, {
        action: "delete",
        target_type: "article",
        target_id: dupe.id,
        reason: `Possible duplicate of ${group[0]!.id} (similar title)`,
        details: JSON.stringify({ title: dupe.title, url: dupe.url, kept_id: group[0]!.id }),
        batch_id: batchId,
      });
      count++;
    }
  }

  return count;
}

async function findStaleErrors(env: Env, batchId: string): Promise<number> {
  const errorArticles = await articleQueries.listRecent(env.CONTENT_DB, { limit: 200, status: "error" });
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  let count = 0;

  for (const article of errorArticles) {
    if (article.ingested_at < sevenDaysAgo) {
      await cleanupLogQueries.insert(env.CONTENT_DB, {
        action: "delete",
        target_type: "article",
        target_id: article.id,
        reason: `Error state for ${Math.floor((Date.now() - new Date(article.ingested_at).getTime()) / 86400000)} days: ${article.error_message ?? "unknown"}`,
        details: JSON.stringify({ url: article.url, error: article.error_message }),
        batch_id: batchId,
      });
      count++;
    }
  }

  return count;
}

async function findOrphans(env: Env, batchId: string): Promise<number> {
  let count = 0;

  // Orphaned R2 objects under html/ and text/
  const articles = await articleQueries.listRecent(env.CONTENT_DB, { limit: 1000 });
  const articleIds = new Set(articles.map((a) => a.id));

  for (const prefix of ["html/", "text/"]) {
    try {
      const keys = await listR2Keys(env.CONTENT_STORE, prefix);
      for (const key of keys) {
        const match = key.match(/\/([^/]+)\.\w+$/);
        if (match && !articleIds.has(match[1]!)) {
          await cleanupLogQueries.insert(env.CONTENT_DB, {
            action: "delete",
            target_type: "orphan_r2",
            target_id: key,
            reason: `R2 object not referenced by any article`,
            batch_id: batchId,
          });
          count++;
        }
      }
    } catch {
      // R2 list may fail, non-fatal
    }
  }

  // Orphaned attachments (no article link)
  const allAttachments = await attachmentQueries.listAll(env.CONTENT_DB, { limit: 500 });
  for (const att of allAttachments) {
    if (!att.article_id) {
      await cleanupLogQueries.insert(env.CONTENT_DB, {
        action: "delete",
        target_type: "attachment",
        target_id: att.id,
        reason: `Attachment not linked to any article: ${att.filename}`,
        details: JSON.stringify({ filename: att.filename, mime_type: att.mime_type, created_at: att.created_at }),
        batch_id: batchId,
      });
      count++;
    }
  }

  return count;
}

async function findUncategorized(env: Env, batchId: string): Promise<number> {
  const articles = await articleQueries.listRecent(env.CONTENT_DB, { limit: 500, status: "ready" });
  let count = 0;

  for (const article of articles) {
    const catCount = await articleCategoryQueries.countForArticle(env.CONTENT_DB, article.id);
    if (catCount === 0) {
      await cleanupLogQueries.insert(env.CONTENT_DB, {
        action: "delete",
        target_type: "article",
        target_id: article.id,
        reason: `No categories assigned`,
        details: JSON.stringify({ title: article.title, url: article.url, ingested_at: article.ingested_at }),
        batch_id: batchId,
      });
      count++;
    }
  }

  return count;
}

// ── Main handler ──────────────────────────────────────────────

export async function cleanup(
  input: CleanupInput,
  env: Env,
): Promise<CleanupOutput> {

  if (input.action === "delete_article") {
    const article = await articleQueries.findById(env.CONTENT_DB, input.article_id);
    if (!article) throw new Error(`Article not found: ${input.article_id}`);
    await cascadeDeleteArticle(env, input.article_id);
    return { action: "delete_article", message: `Deleted article and all related data`, deleted: { article_id: input.article_id, title: article.title } };
  }

  if (input.action === "delete_attachment") {
    const att = await attachmentQueries.findById(env.CONTENT_DB, input.attachment_id);
    if (!att) throw new Error(`Attachment not found: ${input.attachment_id}`);
    await cascadeDeleteAttachment(env, input.attachment_id);
    return { action: "delete_attachment", message: `Deleted attachment "${att.filename}" and related storage` };
  }

  if (input.action === "analyze") {
    const batchId = crypto.randomUUID();
    let total = 0;

    if (input.scope === "all" || input.scope === "duplicates") {
      total += await findDuplicates(env, batchId);
    }
    if (input.scope === "all" || input.scope === "errors") {
      total += await findStaleErrors(env, batchId);
    }
    if (input.scope === "all" || input.scope === "orphans") {
      total += await findOrphans(env, batchId);
    }
    if (input.scope === "all" || input.scope === "uncategorized") {
      total += await findUncategorized(env, batchId);
    }

    return {
      action: "analyze",
      message: total > 0
        ? `Found ${total} cleanup suggestion(s). Use cleanup({action:"review", batch_id:"${batchId}"}) to review them.`
        : "No cleanup issues found.",
      batch_id: batchId,
      suggestions: await cleanupLogQueries.listPending(env.CONTENT_DB, batchId),
    };
  }

  if (input.action === "review") {
    const suggestions = await cleanupLogQueries.listPending(env.CONTENT_DB, input.batch_id);
    return {
      action: "review",
      message: suggestions.length > 0
        ? `${suggestions.length} pending suggestion(s). Approve with cleanup({action:"approve", ids:[...]}) or reject with cleanup({action:"reject", ids:[...]}).`
        : "No pending suggestions.",
      suggestions,
    };
  }

  if (input.action === "approve") {
    await cleanupLogQueries.markApproved(env.CONTENT_DB, input.ids);
    return { action: "approve", message: `Approved ${input.ids.length} suggestion(s). Run cleanup({action:"execute"}) to carry them out.` };
  }

  if (input.action === "reject") {
    await cleanupLogQueries.markRejected(env.CONTENT_DB, input.ids);
    return { action: "reject", message: `Rejected ${input.ids.length} suggestion(s).` };
  }

  // action === "execute"
  const approved = await cleanupLogQueries.listApproved(env.CONTENT_DB);
  if (approved.length === 0) {
    return { action: "execute", message: "No approved suggestions to execute.", executed: 0 };
  }

  let executed = 0;
  for (const entry of approved) {
    try {
      if (entry.target_type === "article") {
        await cascadeDeleteArticle(env, entry.target_id);
      } else if (entry.target_type === "attachment") {
        await cascadeDeleteAttachment(env, entry.target_id);
      } else if (entry.target_type === "orphan_r2") {
        await deleteObject(env.CONTENT_STORE, entry.target_id);
      }
      await cleanupLogQueries.markExecuted(env.CONTENT_DB, entry.id);
      executed++;
    } catch (err) {
      console.warn(`[cleanup] Failed to execute ${entry.id}:`, err);
    }
  }

  return { action: "execute", message: `Executed ${executed} of ${approved.length} approved suggestion(s).`, executed };
}
