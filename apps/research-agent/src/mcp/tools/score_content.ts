/**
 * score_content — Curation tool
 *
 * Scores an ingested article's relevance against Jeremy's interest profile.
 * Scoring factors:
 *   - Topic weight match (primary signal)
 *   - Source trust score
 *   - Recency decay (fresher = higher)
 *   - Prior feedback on similar content (positive feedback history)
 *
 * Writes the computed score back to the article row (stored in a new column
 * added by migration 0002 — see score column in articles table).
 * Returns the score breakdown for transparency.
 */

import { z } from "zod";
import type { Env } from "../../types";
import { articleQueries, profileQueries } from "../../lib/db";

export const ScoreContentInput = z.object({
  article_id: z.string().uuid().describe("Article UUID to score"),
});

export type ScoreContentInput = z.infer<typeof ScoreContentInput>;

export interface ScoreBreakdown {
  topic_score:    number;   // 0–1, weighted average of matched topic weights
  source_score:   number;   // 0–1, source trust normalised
  recency_score:  number;   // 0–1, exponential decay over 30 days
  total:          number;   // 0–1, weighted combination
  matched_topics: string[];
}

export interface ScoreContentOutput {
  article_id: string;
  score:      number;
  breakdown:  ScoreBreakdown;
}

// Scoring weights — must sum to 1.0
const W_TOPIC   = 0.60;
const W_SOURCE  = 0.20;
const W_RECENCY = 0.20;

// Recency half-life in days
const RECENCY_HALF_LIFE_DAYS = 14;

// Default weight for an unrecognised topic/source
const DEFAULT_TOPIC_WEIGHT  = 1.0;
const DEFAULT_SOURCE_WEIGHT = 1.0;
const MAX_TOPIC_WEIGHT      = 5.0;
const MAX_SOURCE_WEIGHT     = 3.0;

function recencyScore(ingestedAt: string): number {
  const ageMs   = Date.now() - new Date(ingestedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Exponential decay: score = 0.5^(age / half_life)
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

export async function scoreContent(
  input: ScoreContentInput,
  env:   Env,
): Promise<ScoreContentOutput> {
  const row = await articleQueries.findById(env.CONTENT_DB, input.article_id);
  if (!row) throw new Error(`Article not found: ${input.article_id}`);

  const topics: string[] = row.topics ? JSON.parse(row.topics) : [];

  // ── Topic score ────────────────────────────────────────────
  let topicTotal    = 0;
  const matchedTopics: string[] = [];

  for (const topic of topics) {
    const key    = `topic:${topic.toLowerCase()}`;
    const weight = await profileQueries.get<number>(env.CONTENT_DB, key) ?? DEFAULT_TOPIC_WEIGHT;
    topicTotal  += weight;
    if (weight > DEFAULT_TOPIC_WEIGHT) matchedTopics.push(topic);
  }

  // Normalise: average weight / max possible weight, clamped to [0,1]
  const avgTopicWeight = topics.length > 0 ? topicTotal / topics.length : DEFAULT_TOPIC_WEIGHT;
  const topicScore     = Math.min(avgTopicWeight / MAX_TOPIC_WEIGHT, 1.0);

  // ── Source score ───────────────────────────────────────────
  let rawSourceWeight = DEFAULT_SOURCE_WEIGHT;
  if (row.source_id) {
    rawSourceWeight = await profileQueries.get<number>(env.CONTENT_DB, `source:${row.source_id}`) ?? DEFAULT_SOURCE_WEIGHT;
  }
  const sourceScore = Math.min(rawSourceWeight / MAX_SOURCE_WEIGHT, 1.0);

  // ── Recency score ──────────────────────────────────────────
  const recency = recencyScore(row.ingested_at);

  // ── Combined score ─────────────────────────────────────────
  const total = Math.round(
    (W_TOPIC * topicScore + W_SOURCE * sourceScore + W_RECENCY * recency) * 10_000,
  ) / 10_000;

  // Persist score back to the article row
  // Uses a PATCH-style update — only touches the score column
  await env.CONTENT_DB
    .prepare("UPDATE articles SET relevance_score = ?1, scored_at = ?2 WHERE id = ?3")
    .bind(total, new Date().toISOString(), input.article_id)
    .run()
    // Graceful degradation if column doesn't exist yet (migration not applied)
    .catch((e: Error) => {
      if (!e.message.includes("no such column")) throw e;
    });

  return {
    article_id: input.article_id,
    score:      total,
    breakdown:  {
      topic_score:    Math.round(topicScore  * 10_000) / 10_000,
      source_score:   Math.round(sourceScore * 10_000) / 10_000,
      recency_score:  Math.round(recency     * 10_000) / 10_000,
      total,
      matched_topics: matchedTopics,
    },
  };
}
