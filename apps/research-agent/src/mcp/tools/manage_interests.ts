/**
 * manage_interests — Curation tool
 *
 * View or edit Jeremy's interest profile:
 *   - get:    returns full profile (topic, category, source weights, settings)
 *   - update: patch specific keys
 *   - reset:  wipe all topic/category/source weights back to defaults
 *   - seed:   bootstrap the profile with Jeremy's curated interests
 *             (L&D, AI adoption, leadership, etc.) and create any missing
 *             categories. Idempotent — safe to re-run.
 */

import { z } from "zod";
import type { Env } from "../../types";
import { categoryQueries, profileQueries } from "../../lib/db";
import type { CategoryRow } from "../../lib/db";

export const ManageInterestsInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("get"),
  }),
  z.object({
    action: z.literal("update"),
    patch: z.record(z.string(), z.unknown())
      .describe("Key-value pairs to set. Keys: 'topic:<name>', 'category:<slug>', 'source:<id>', 'setting:<key>'"),
  }),
  z.object({
    action: z.literal("reset"),
    scope: z.enum(["topics", "categories", "sources", "all"]).default("all")
      .describe("What to reset: topic weights, category weights, source weights, or everything"),
  }),
  z.object({
    action: z.literal("seed"),
    overwrite: z.boolean().default(false)
      .describe("If true, replace existing weights. If false, only set keys not already in the profile."),
  }),
]);

export type ManageInterestsInput = z.infer<typeof ManageInterestsInput>;

export interface InterestProfile {
  topics:     Record<string, number>;
  categories: Record<string, number>;
  sources:    Record<string, number>;
  settings:   Record<string, unknown>;
  meta:       Record<string, unknown>;
}

export interface ManageInterestsOutput {
  action:   string;
  profile:  InterestProfile;
  changed?: string[];
  created_categories?: string[];
}

function categorise(raw: Record<string, unknown>): InterestProfile {
  const profile: InterestProfile = { topics: {}, categories: {}, sources: {}, settings: {}, meta: {} };
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("topic:"))         profile.topics[key.slice(6)]     = value as number;
    else if (key.startsWith("category:")) profile.categories[key.slice(9)] = value as number;
    else if (key.startsWith("source:"))   profile.sources[key.slice(7)]    = value as number;
    else if (key.startsWith("setting:"))  profile.settings[key.slice(8)]   = value;
    else if (key.startsWith("meta:"))     profile.meta[key.slice(5)]       = value;
  }
  return profile;
}

const DEFAULT_SETTINGS: Record<string, unknown> = {
  "setting:digest_frequency":  "on-demand",
  "setting:max_digest_items":  15,
  "setting:summary_style":     "concise",
  "meta:schema_version":       2,
};

// Jeremy's curated interests. Categories are created if missing; weights are
// written to the interest_profile table against both the category slug and
// equivalent topic strings so AI-extracted topics still land in the profile.
//
// Weight range: 1.0 (neutral/default) → 5.0 (max boost). Below 1.0 suppresses.
interface SeedCategory {
  name:        string;
  description: string;
  weight:      number;
  color?:      string;
  keywords:    string[];  // also written as topic:<kw> = weight
}

const SEED_CATEGORIES: SeedCategory[] = [
  {
    name: "L&D / Learning Design",
    description: "Learning and development, instructional design, corporate training, learning science.",
    weight: 4.5,
    color: "#3B82F6",
    keywords: ["l&d", "learning design", "instructional design", "learning and development", "corporate training", "learning science", "training design"],
  },
  {
    name: "AI Adoption & Org Transformation",
    description: "How organisations adopt AI, change management, workflow redesign, AI in the enterprise.",
    weight: 4.5,
    color: "#8B5CF6",
    keywords: ["ai adoption", "ai transformation", "ai in the enterprise", "enterprise ai", "ai strategy", "generative ai", "change management", "digital transformation", "ai workflow"],
  },
  {
    name: "Leadership Development",
    description: "Developing leaders, executive coaching, leadership capability.",
    weight: 4.0,
    color: "#F59E0B",
    keywords: ["leadership", "leadership development", "executive coaching", "leader development", "managerial skills"],
  },
  {
    name: "Management Effectiveness",
    description: "Manager effectiveness, performance management, team leadership, people management.",
    weight: 3.8,
    color: "#10B981",
    keywords: ["management effectiveness", "manager effectiveness", "performance management", "people management", "team leadership", "management practices"],
  },
  {
    name: "Career Development",
    description: "Career pathing, talent mobility, professional growth, skills development.",
    weight: 3.5,
    color: "#EC4899",
    keywords: ["career development", "career pathing", "talent mobility", "skills development", "professional growth", "reskilling", "upskilling"],
  },
  {
    name: "Learning Technology",
    description: "LMS, LXP, learning platforms, EdTech for the enterprise, learning analytics.",
    weight: 3.8,
    color: "#06B6D4",
    keywords: ["learning technology", "lms", "lxp", "learning platform", "edtech", "learning analytics", "learning experience"],
  },
  {
    name: "Instructional Design",
    description: "Course design, curriculum, pedagogy, learning experience design.",
    weight: 3.8,
    color: "#F97316",
    keywords: ["instructional design", "curriculum design", "course design", "pedagogy", "learning experience design", "lxd"],
  },
  {
    name: "Org Design",
    description: "Organisation design, operating models, team structures, ways of working.",
    weight: 3.5,
    color: "#6366F1",
    keywords: ["org design", "organization design", "organisation design", "operating model", "team structure", "ways of working"],
  },
  // Lower-weighted topics — suppress but don't hide.
  {
    name: "Politics",
    description: "General political news and commentary (lower priority).",
    weight: 0.3,
    color: "#6B7280",
    keywords: ["politics", "election", "parliament", "congress", "political"],
  },
  {
    name: "UK News",
    description: "General UK news that isn't work-relevant (lower priority).",
    weight: 0.4,
    color: "#6B7280",
    keywords: ["uk news", "britain", "british", "westminster"],
  },
  {
    name: "Climate",
    description: "Climate change and environment (lower priority unless work-adjacent).",
    weight: 0.4,
    color: "#6B7280",
    keywords: ["climate", "climate change", "global warming", "environment"],
  },
  {
    name: "Sports",
    description: "Sports news and commentary (lower priority).",
    weight: 0.2,
    color: "#6B7280",
    keywords: ["sport", "sports", "football", "soccer", "cricket", "rugby", "tennis", "nba", "nfl"],
  },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function ensureCategory(
  env: Env,
  seed: SeedCategory,
): Promise<{ category: CategoryRow; created: boolean }> {
  const slug = slugify(seed.name);
  const existing = await categoryQueries.findBySlug(env.CONTENT_DB, slug);
  if (existing) return { category: existing, created: false };

  const category = await categoryQueries.create(env.CONTENT_DB, {
    name: seed.name,
    description: seed.description,
    ...(seed.color !== undefined ? { color: seed.color } : {}),
  });
  return { category, created: true };
}

export async function manageInterests(
  input: ManageInterestsInput,
  env:   Env,
): Promise<ManageInterestsOutput> {

  if (input.action === "get") {
    const raw = await profileQueries.getAll(env.CONTENT_DB);
    return { action: "get", profile: categorise(raw) };
  }

  if (input.action === "update") {
    const changed: string[] = [];
    for (const [key, value] of Object.entries(input.patch)) {
      if (
        !key.startsWith("topic:")    &&
        !key.startsWith("category:") &&
        !key.startsWith("source:")   &&
        !key.startsWith("setting:")  &&
        !key.startsWith("meta:")
      ) {
        throw new Error(`Invalid key "${key}". Must start with topic:, category:, source:, setting:, or meta:`);
      }
      await profileQueries.set(env.CONTENT_DB, key, value);
      changed.push(key);
    }
    const raw = await profileQueries.getAll(env.CONTENT_DB);
    return { action: "update", profile: categorise(raw), changed };
  }

  if (input.action === "reset") {
    const raw = await profileQueries.getAll(env.CONTENT_DB);
    const keysToDelete: string[] = [];

    for (const key of Object.keys(raw)) {
      if (input.scope === "all")           keysToDelete.push(key);
      else if (input.scope === "topics"     && key.startsWith("topic:"))    keysToDelete.push(key);
      else if (input.scope === "categories" && key.startsWith("category:")) keysToDelete.push(key);
      else if (input.scope === "sources"    && key.startsWith("source:"))   keysToDelete.push(key);
    }

    for (const key of keysToDelete) {
      await profileQueries.delete(env.CONTENT_DB, key);
    }

    // Re-seed default settings if wiping everything
    if (input.scope === "all") {
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        await profileQueries.set(env.CONTENT_DB, key, value);
      }
    }

    const refreshed = await profileQueries.getAll(env.CONTENT_DB);
    return { action: "reset", profile: categorise(refreshed), changed: keysToDelete };
  }

  // action === "seed"
  const existing = await profileQueries.getAll(env.CONTENT_DB);
  const changed: string[] = [];
  const createdCategories: string[] = [];

  const shouldWrite = (key: string): boolean =>
    input.overwrite || !(key in existing);

  // 1. Ensure categories exist, set category:<slug> weights.
  for (const seed of SEED_CATEGORIES) {
    const { category, created } = await ensureCategory(env, seed);
    if (created) createdCategories.push(category.name);

    const catKey = `category:${category.slug}`;
    if (shouldWrite(catKey)) {
      await profileQueries.set(env.CONTENT_DB, catKey, seed.weight);
      changed.push(catKey);
    }

    // 2. Also write topic weights so AI-extracted topic strings hit the profile.
    for (const kw of seed.keywords) {
      const topicKey = `topic:${kw.toLowerCase()}`;
      if (shouldWrite(topicKey)) {
        await profileQueries.set(env.CONTENT_DB, topicKey, seed.weight);
        changed.push(topicKey);
      }
    }
  }

  // 3. Seed default settings if absent.
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (shouldWrite(key)) {
      await profileQueries.set(env.CONTENT_DB, key, value);
      changed.push(key);
    }
  }

  const refreshed = await profileQueries.getAll(env.CONTENT_DB);
  return {
    action: "seed",
    profile: categorise(refreshed),
    changed,
    created_categories: createdCategories,
  };
}
