import type { D1Database } from "@cloudflare/workers-types";
import type { Ai } from "../types";
import { categoryQueries, articleCategoryQueries } from "./db";
import type { CategoryRow } from "./db";

const CATEGORIZE_MODEL = "@cf/meta/llama-3.1-8b-instruct" as const;

export async function suggestCategories(
  ai: Ai,
  content: { title?: string | null; summary?: string | null; topics?: string[] },
  categories: CategoryRow[],
): Promise<string[]> {
  if (categories.length === 0) return [];

  const categoryList = categories.map((c) => `- ${c.name}: ${c.description ?? c.name}`).join("\n");
  const articleInfo = [
    content.title ? `Title: ${content.title}` : null,
    content.summary ? `Summary: ${content.summary}` : null,
    content.topics?.length ? `Topics: ${content.topics.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  const response = await ai.run(CATEGORIZE_MODEL, {
    messages: [
      { role: "system", content: "You are a JSON-only categorization API. Respond with ONLY a JSON array of category names." },
      {
        role: "user",
        content: `Given this article:\n${articleInfo}\n\nWhich of these categories apply? Return ONLY a JSON array of matching category names (empty array if none match).\n\nCategories:\n${categoryList}\n\nJSON array:`,
      },
    ],
    max_tokens: 200,
    temperature: 0.1,
  });

  const raw = response.response.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const names = parsed.filter((v): v is string => typeof v === "string");
    const categoryNameMap = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
    return names
      .map((n) => categoryNameMap.get(n.toLowerCase()))
      .filter((id): id is string => id !== undefined);
  } catch {
    return [];
  }
}

export async function autoAssignCategories(
  db: D1Database,
  ai: Ai,
  articleId: string,
  articleContent: { title?: string | null; summary?: string | null; topics?: string[] },
): Promise<string[]> {
  const allCategories = await categoryQueries.list(db);
  if (allCategories.length === 0) return [];

  const matchedIds = await suggestCategories(ai, articleContent, allCategories);
  if (matchedIds.length === 0) return [];

  await articleCategoryQueries.bulkAssign(db, articleId, matchedIds, "auto");
  return matchedIds;
}
