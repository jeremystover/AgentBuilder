import type { D1Database } from "@cloudflare/workers-types";
import type { Ai } from "../types";
import { categoryQueries, articleCategoryQueries } from "./db";
import type { CategoryRow } from "./db";

const CATEGORIZE_MODEL = "@cf/meta/llama-3.1-8b-instruct" as const;

// Terms we should not treat as meaningful keywords when tokenising
// category names/descriptions or article titles/summaries.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "by",
  "with", "as", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "from", "into", "over",
  "about", "how", "why", "what", "when", "which", "who", "whom",
  "content", "article", "articles", "news", "related",
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s&/+-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function buildCategoryKeywords(cat: CategoryRow): string[] {
  const raw = `${cat.name} ${cat.description ?? ""}`;
  const tokens = new Set(tokenise(raw));
  // Add the full category name (lowercased) as a phrase for robust matching
  tokens.add(cat.name.toLowerCase().trim());
  return [...tokens].filter((t) => t.length > 0);
}

export function keywordMatchCategories(
  content: { title?: string | null; summary?: string | null; topics?: string[] },
  categories: CategoryRow[],
): string[] {
  if (categories.length === 0) return [];

  const haystack = [
    content.title ?? "",
    content.summary ?? "",
    ...(content.topics ?? []),
  ].join(" \n ").toLowerCase();

  const matched: Array<{ id: string; hits: number }> = [];

  for (const cat of categories) {
    const keywords = buildCategoryKeywords(cat);
    let hits = 0;
    for (const kw of keywords) {
      // Multi-word keywords match as phrases; single-word as word-boundary.
      if (kw.includes(" ") || kw.includes("-") || kw.includes("&")) {
        if (haystack.includes(kw)) hits++;
      } else {
        const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (re.test(haystack)) hits++;
      }
    }
    if (hits > 0) matched.push({ id: cat.id, hits });
  }

  matched.sort((a, b) => b.hits - a.hits);
  return matched.slice(0, 5).map((m) => m.id);
}

export async function suggestCategories(
  ai: Ai,
  content: { title?: string | null; summary?: string | null; topics?: string[] },
  categories: CategoryRow[],
): Promise<string[]> {
  if (categories.length === 0) return [];

  // 1. Deterministic keyword pass first — cheap, reliable, and often sufficient.
  const keywordMatches = keywordMatchCategories(content, categories);
  if (keywordMatches.length > 0) return keywordMatches;

  // 2. Fallback: LLM-based matching for less obvious cases.
  const categoryList = categories.map((c) => `- ${c.name}: ${c.description ?? c.name}`).join("\n");
  const articleInfo = [
    content.title ? `Title: ${content.title}` : null,
    content.summary ? `Summary: ${content.summary}` : null,
    content.topics?.length ? `Topics: ${content.topics.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  try {
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
