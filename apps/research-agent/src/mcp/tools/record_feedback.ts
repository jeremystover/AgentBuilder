/**
 * record_feedback — Curation tool
 *
 * Records a thumbs-up signal on an article and updates the interest profile:
 *   - Boosts topic weights for topics on the article
 *   - Increments source trust score
 *   - Stores the feedback event for audit/trend analysis
 */

import { z } from "zod";
import type { Env } from "../../types";
import { articleQueries, feedbackQueries, profileQueries } from "../../lib/db";

export const RecordFeedbackInput = z.object({
  article_id: z.string().uuid().describe("Article UUID to record feedback on"),
  signal: z.enum(["thumbs_up"]).describe("Feedback signal (v1: thumbs_up only)"),
  note: z.string().max(500).optional().describe("Optional note about why you liked this"),
});

export type RecordFeedbackInput = z.infer<typeof RecordFeedbackInput>;

export interface RecordFeedbackOutput {
  ok:         boolean;
  article_id: string;
  signal:     string;
  topics_boosted: string[];
  source_id:  string | null;
}

const TOPIC_BOOST      = 0.1;
const SOURCE_BOOST     = 0.05;
const MAX_TOPIC_WEIGHT = 5.0;
const MAX_SOURCE_WEIGHT = 3.0;

export async function recordFeedback(
  input: RecordFeedbackInput,
  env:   Env,
): Promise<RecordFeedbackOutput> {
  const row = await articleQueries.findById(env.CONTENT_DB, input.article_id);
  if (!row) throw new Error(`Article not found: ${input.article_id}`);

  // Persist the feedback event
  await feedbackQueries.insert(env.CONTENT_DB, {
    article_id: input.article_id,
    signal:     input.signal,
    context:    JSON.stringify({ source: "manual" }),
    // Conditionally include note — exactOptionalPropertyTypes disallows passing undefined
    ...(input.note !== undefined ? { note: input.note } : {}),
  });

  const topics: string[] = row.topics ? JSON.parse(row.topics) : [];

  // Boost topic weights in interest profile
  for (const topic of topics) {
    const key = `topic:${topic.toLowerCase()}`;
    const current = await profileQueries.get<number>(env.CONTENT_DB, key) ?? 1.0;
    const updated = Math.min(current + TOPIC_BOOST, MAX_TOPIC_WEIGHT);
    await profileQueries.set(env.CONTENT_DB, key, updated);
  }

  // Boost source trust score
  if (row.source_id) {
    const key = `source:${row.source_id}`;
    const current = await profileQueries.get<number>(env.CONTENT_DB, key) ?? 1.0;
    const updated = Math.min(current + SOURCE_BOOST, MAX_SOURCE_WEIGHT);
    await profileQueries.set(env.CONTENT_DB, key, updated);
  }

  return {
    ok:             true,
    article_id:     input.article_id,
    signal:         input.signal,
    topics_boosted: topics,
    source_id:      row.source_id ?? null,
  };
}
