import { z } from "zod";
import type { Env } from "../../types";
import {
  articleQueries,
  articleCategoryQueries,
  categoryQueries,
  attachmentQueries,
} from "../../lib/db";
import type { CategoryRow } from "../../lib/db";
import { suggestCategories } from "../../lib/categorize";

export const TagContentInput = z.discriminatedUnion("action", [
  z.object({
    action:      z.literal("assign"),
    article_id:  z.string().uuid(),
    category_ids: z.array(z.string().uuid()).min(1).describe("Category IDs to assign"),
  }),
  z.object({
    action:      z.literal("remove"),
    article_id:  z.string().uuid(),
    category_ids: z.array(z.string().uuid()).min(1).describe("Category IDs to remove"),
  }),
  z.object({
    action:     z.literal("list"),
    article_id: z.string().uuid(),
  }),
  z.object({
    action:     z.literal("suggest"),
    article_id: z.string().uuid().describe("Article to auto-suggest categories for"),
  }),
  z.object({
    action:      z.literal("bulk_assign"),
    article_ids: z.array(z.string().uuid()).min(1).max(50),
    category_ids: z.array(z.string().uuid()).min(1),
  }),
]);

export type TagContentInput = z.infer<typeof TagContentInput>;

export interface TagContentOutput {
  action:      string;
  article_id?: string;
  categories:  CategoryRow[];
  message?:    string;
  suggested?:  CategoryRow[];
}

export async function tagContent(
  input: TagContentInput,
  env: Env,
): Promise<TagContentOutput> {
  const db = env.CONTENT_DB;

  if (input.action === "assign") {
    const article = await articleQueries.findById(db, input.article_id);
    if (!article) throw new Error(`Article not found: ${input.article_id}`);

    for (const catId of input.category_ids) {
      const cat = await categoryQueries.findById(db, catId);
      if (!cat) throw new Error(`Category not found: ${catId}`);
    }

    await articleCategoryQueries.bulkAssign(db, input.article_id, input.category_ids, "manual");
    const categories = await articleCategoryQueries.listForArticle(db, input.article_id);
    return { action: "assign", article_id: input.article_id, categories, message: `Assigned ${input.category_ids.length} category(s)` };
  }

  if (input.action === "remove") {
    for (const catId of input.category_ids) {
      await articleCategoryQueries.remove(db, input.article_id, catId);
    }
    const categories = await articleCategoryQueries.listForArticle(db, input.article_id);
    return { action: "remove", article_id: input.article_id, categories, message: `Removed ${input.category_ids.length} category(s)` };
  }

  if (input.action === "list") {
    const categories = await articleCategoryQueries.listForArticle(db, input.article_id);
    return { action: "list", article_id: input.article_id, categories };
  }

  if (input.action === "suggest") {
    const article = await articleQueries.findById(db, input.article_id);
    if (!article) throw new Error(`Article not found: ${input.article_id}`);

    const allCategories = await categoryQueries.list(db);
    if (allCategories.length === 0) {
      return { action: "suggest", article_id: input.article_id, categories: [], suggested: [], message: "No categories exist yet. Create some first." };
    }

    const topics: string[] = article.topics ? JSON.parse(article.topics) : [];
    const matchedIds = await suggestCategories(
      env.AI,
      { title: article.title, summary: article.summary, topics },
      allCategories,
    );

    const suggested = allCategories.filter((c) => matchedIds.includes(c.id));
    const existing = await articleCategoryQueries.listForArticle(db, input.article_id);
    return { action: "suggest", article_id: input.article_id, categories: existing, suggested };
  }

  // action === "bulk_assign"
  for (const articleId of input.article_ids) {
    await articleCategoryQueries.bulkAssign(db, articleId, input.category_ids, "manual");
  }
  const categories = input.category_ids.length > 0
    ? await Promise.all(input.category_ids.map((id) => categoryQueries.findById(db, id)))
    : [];
  return {
    action: "bulk_assign",
    categories: categories.filter((c): c is CategoryRow => c !== null),
    message: `Assigned ${input.category_ids.length} category(s) to ${input.article_ids.length} article(s)`,
  };
}
