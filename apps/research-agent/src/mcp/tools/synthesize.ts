import { z } from "zod";
import type { Env } from "../../types";
import { queryVectors } from "../../lib/vectors";
import { articleQueries } from "../../lib/db";
import { getObject } from "../../lib/storage";
import type { ArticleRow } from "../../lib/db";

export const SynthesizeInput = z.object({
  question:         z.string().min(1).max(2000).describe("The question or topic to synthesize an answer for"),
  top_k:            z.number().int().min(1).max(20).default(8),
  min_score:        z.number().min(0).max(1).default(0.45),
  include_fulltext: z.boolean().default(false).describe("Pull full article text into context (richer but slower)"),
  style:            z.enum(["concise", "detailed", "bullets"]).default("concise"),
});

export type SynthesizeInput = z.infer<typeof SynthesizeInput>;

export interface Citation {
  index:        number;
  article_id:   string;
  title:        string | null;
  url:          string;
  score:        number;
  published_at: string | null;
}

export interface SynthesizeOutput {
  question:     string;
  answer:       string;
  citations:    Citation[];
  model:        string;
  sources_used: number;
}

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5" as const;
const SYNTH_MODEL = "@cf/meta/llama-3.1-8b-instruct" as const;
const CHARS_PER_SOURCE_SUMMARY  = 600;
const CHARS_PER_SOURCE_FULLTEXT = 1_800;

interface SourceChunk { row: ArticleRow; score: number; text: string; }

async function buildSourceChunks(
  rows: ArticleRow[], scores: Map<string, number>, env: Env, includeFulltext: boolean,
): Promise<SourceChunk[]> {
  const chunks: SourceChunk[] = [];
  for (const row of rows) {
    let text = "";
    if (includeFulltext) {
      if (row.full_text) text = row.full_text.slice(0, CHARS_PER_SOURCE_FULLTEXT);
      else if (row.r2_key) {
        const r2text = await getObject(env.CONTENT_STORE, row.r2_key);
        text = (r2text ?? "").slice(0, CHARS_PER_SOURCE_FULLTEXT);
      }
    }
    if (text.length < 100 && row.summary) text = row.summary.slice(0, CHARS_PER_SOURCE_SUMMARY);
    if (!text && row.title) text = row.title;
    if (!text) continue;
    chunks.push({ row, score: scores.get(row.id) ?? 0, text });
  }
  return chunks;
}

const STYLE_INSTRUCTIONS = {
  concise:  "Answer in 2-4 concise paragraphs. Be direct and informative.",
  detailed: "Answer thoroughly with multiple paragraphs covering different aspects.",
  bullets:  "Answer using clear bullet points. Each bullet should be a distinct insight.",
};

export async function synthesize(input: SynthesizeInput, env: Env): Promise<SynthesizeOutput> {
  const { question, top_k, min_score, include_fulltext, style } = input;

  const embedResp = await env.AI.run(EMBED_MODEL, { text: [question] });
  const queryVec  = embedResp.data[0];
  if (!queryVec) throw new Error("Embedding returned no vector");

  const matches = await queryVectors(env.CONTENT_VECTORS, queryVec, { topK: top_k, returnMetadata: true });
  const aboveThreshold = matches.filter((m) => m.score >= min_score);

  if (aboveThreshold.length === 0) {
    return {
      question, answer: "I don't have articles relevant enough to answer this. Try ingesting some sources first, or lower the minimum similarity threshold.",
      citations: [], model: SYNTH_MODEL, sources_used: 0,
    };
  }

  const ids      = aboveThreshold.map((m) => m.id);
  const rows     = await articleQueries.fetchIdsIn(env.CONTENT_DB, ids);
  const scoreMap = new Map(aboveThreshold.map((m) => [m.id, m.score]));

  const orderedRows = ids
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is ArticleRow => !!r && r.status === "ready");

  const chunks = await buildSourceChunks(orderedRows, scoreMap, env, include_fulltext);

  if (chunks.length === 0) {
    return { question, answer: "Retrieved articles were empty or unavailable.", citations: [], model: SYNTH_MODEL, sources_used: 0 };
  }

  const sourceBlock = chunks.map((chunk, i) => {
    const meta = [
      chunk.row.title  ? `Title: ${chunk.row.title}` : null,
      chunk.row.author ? `Author: ${chunk.row.author}` : null,
      chunk.row.published_at ? `Published: ${chunk.row.published_at.slice(0, 10)}` : null,
      `URL: ${chunk.row.url}`,
    ].filter(Boolean).join(" | ");
    return `[${i + 1}] ${meta}\n${chunk.text}`;
  }).join("\n\n---\n\n");

  const systemPrompt = `You are Content Brain, a personal research assistant.
Answer questions using ONLY the provided source excerpts.
${STYLE_INSTRUCTIONS[style]}
Cite sources inline using [1], [2], etc. Every factual claim must have a citation.
Do not fabricate facts. Output ONLY the JSON object, nothing else.`;

  const llmResp = await env.AI.run(SYNTH_MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: `SOURCES:\n\n${sourceBlock}\n\n---\n\nQUESTION: ${question}` },
    ],
    max_tokens: 1_024, temperature: 0.3,
  });

  const answer = llmResp.response.trim();

  const citedIndices = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const n = parseInt(match[1]!, 10);
    if (n >= 1 && n <= chunks.length) citedIndices.add(n);
  }

  const indicesToCite = citedIndices.size > 0 ? citedIndices : new Set(chunks.map((_, i) => i + 1));

  const citations: Citation[] = [];
  for (const idx of [...indicesToCite].sort((a, b) => a - b)) {
    const chunk = chunks[idx - 1];
    if (!chunk) continue;
    citations.push({
      index: idx, article_id: chunk.row.id, title: chunk.row.title ?? null,
      url: chunk.row.url, score: Math.round((scoreMap.get(chunk.row.id) ?? 0) * 10_000) / 10_000,
      published_at: chunk.row.published_at ?? null,
    });
  }

  return { question, answer, citations, model: SYNTH_MODEL, sources_used: chunks.length };
}
