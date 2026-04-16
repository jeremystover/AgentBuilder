/**
 * manage_interests — Curation tool
 *
 * View or edit Jeremy's interest profile:
 *   - get:    returns full profile (topic weights, source scores, settings)
 *   - update: patch specific keys
 *   - reset:  wipe all topic/source weights back to defaults
 */

import { z } from "zod";
import type { Env } from "../../types";
import { profileQueries } from "../../lib/db";

export const ManageInterestsInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("get"),
  }),
  z.object({
    action: z.literal("update"),
    patch: z.record(z.string(), z.unknown())
      .describe("Key-value pairs to set. Keys: 'topic:<name>', 'source:<id>', 'setting:<key>'"),
  }),
  z.object({
    action: z.literal("reset"),
    scope: z.enum(["topics", "sources", "all"]).default("all")
      .describe("What to reset: topic weights, source weights, or everything"),
  }),
]);

export type ManageInterestsInput = z.infer<typeof ManageInterestsInput>;

export interface InterestProfile {
  topics:   Record<string, number>;
  sources:  Record<string, number>;
  settings: Record<string, unknown>;
  meta:     Record<string, unknown>;
}

export interface ManageInterestsOutput {
  action:  string;
  profile: InterestProfile;
  changed?: string[];
}

function categorise(raw: Record<string, unknown>): InterestProfile {
  const profile: InterestProfile = { topics: {}, sources: {}, settings: {}, meta: {} };
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("topic:"))   profile.topics[key.slice(6)]   = value as number;
    else if (key.startsWith("source:"))  profile.sources[key.slice(7)]  = value as number;
    else if (key.startsWith("setting:")) profile.settings[key.slice(8)] = value;
    else if (key.startsWith("meta:"))    profile.meta[key.slice(5)]    = value;
  }
  return profile;
}

const DEFAULT_SETTINGS: Record<string, unknown> = {
  "setting:digest_frequency":  "on-demand",
  "setting:max_digest_items":  15,
  "setting:summary_style":     "concise",
  "meta:schema_version":       1,
};

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
      // Validate key namespace
      if (
        !key.startsWith("topic:")   &&
        !key.startsWith("source:")  &&
        !key.startsWith("setting:") &&
        !key.startsWith("meta:")
      ) {
        throw new Error(`Invalid key "${key}". Must start with topic:, source:, setting:, or meta:`);
      }
      await profileQueries.set(env.CONTENT_DB, key, value);
      changed.push(key);
    }
    const raw = await profileQueries.getAll(env.CONTENT_DB);
    return { action: "update", profile: categorise(raw), changed };
  }

  // action === "reset"
  const raw = await profileQueries.getAll(env.CONTENT_DB);
  const keysToDelete: string[] = [];

  for (const key of Object.keys(raw)) {
    if (input.scope === "all")    keysToDelete.push(key);
    else if (input.scope === "topics"  && key.startsWith("topic:"))  keysToDelete.push(key);
    else if (input.scope === "sources" && key.startsWith("source:")) keysToDelete.push(key);
  }

  for (const key of keysToDelete) {
    await profileQueries.delete(env.CONTENT_DB, key);
  }

  // Re-seed defaults if wiping everything
  if (input.scope === "all") {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await profileQueries.set(env.CONTENT_DB, key, value);
    }
  }

  const refreshed = await profileQueries.getAll(env.CONTENT_DB);
  return { action: "reset", profile: categorise(refreshed), changed: keysToDelete };
}
