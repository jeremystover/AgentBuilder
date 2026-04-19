/**
 * generate_logo_concepts — produce 6-10 logo concepts from a chat-gathered brief.
 *
 * Pipeline:
 *   1. Load the chat history for sessionId from chat_messages.
 *   2. Ask the LLM (deep tier) to extract a structured design brief and
 *      produce N diverse concept prompts spanning the requested styles.
 *   3. For each concept, call OpenAI gpt-image-1; save PNG to R2.
 *   4. Create a `projects` row (kind='logo') if none exists for this session,
 *      then insert logo_concepts rows.
 *   5. Return the gallery: per-concept id, style, preview URL, prompt used.
 *
 * Concurrency: image generation runs 3-at-a-time to avoid rate-limit spikes.
 */

import { AgentError, createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../../worker-configuration';

const OPENAI_IMAGES_API = 'https://api.openai.com/v1/images/generations';
const DEFAULT_COUNT = 6;
const MAX_COUNT = 10;

export type LogoStyle = 'mark' | 'wordmark' | 'combo' | 'lettermark' | 'emblem';

export interface GenerateLogoConceptsArgs {
  sessionId: string;
  count?: number;
  styles?: LogoStyle[];
  userId?: string;
}

export interface LogoConcept {
  id: string;
  iteration: number;
  style: LogoStyle;
  prompt: string;
  previewUrl: string;     // r2:// URL (caller resolves to public URL)
  r2Key: string;
}

export interface GenerateLogoConceptsResult {
  ok: true;
  projectId: string;
  iteration: number;
  brief: DesignBrief;
  concepts: LogoConcept[];
}

export interface DesignBrief {
  companyName: string;
  tagline: string | null;
  industry: string;
  audience: string;
  moodWords: string[];
  colorPreferences: string[];
  inspirations: string[];
  avoid: string[];
}

interface ChatRow {
  role: string;
  content: string;
}

interface ConceptDraft {
  style: LogoStyle;
  prompt: string;
}

interface BriefAndPrompts {
  brief: DesignBrief;
  concepts: ConceptDraft[];
}

export async function generateLogoConcepts(
  env: Env,
  args: GenerateLogoConceptsArgs,
): Promise<GenerateLogoConceptsResult> {
  const logger = createLogger({
    base: { agent: 'graphic-designer', tool: 'generate_logo_concepts' },
  });
  const userId = args.userId ?? 'default';
  const count = Math.min(Math.max(args.count ?? DEFAULT_COUNT, 3), MAX_COUNT);
  const styles: LogoStyle[] = args.styles?.length
    ? args.styles
    : ['mark', 'wordmark', 'combo', 'lettermark', 'emblem'];

  if (!env.OPENAI_API_KEY) {
    throw new AgentError('OPENAI_API_KEY not set; cannot generate concepts.', { code: 'internal' });
  }

  const chat = await env.DB.prepare(
    `SELECT role, content FROM chat_messages
      WHERE session_id = ?1
      ORDER BY created_at ASC
      LIMIT 60`,
  )
    .bind(args.sessionId)
    .all<ChatRow>();

  const history = chat.results ?? [];
  if (history.length === 0) {
    throw new AgentError(
      `No chat history for session "${args.sessionId}". Run a logo interview via the chat tool first.`,
      { code: 'invalid_input' },
    );
  }

  logger.info('brief.extract', { turns: history.length, count, styles });

  const llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY, workersAi: env.AI });
  const { brief, concepts } = await extractBriefAndPrompts(llm, history, count, styles);

  // Create / reuse logo project for this session
  const projectId = await upsertLogoProject(env.DB, {
    userId,
    sessionId: args.sessionId,
    name: brief.companyName || `Logo — ${new Date().toISOString().slice(0, 10)}`,
    brief,
  });

  // Determine iteration number
  const iterRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(iteration), 0) AS maxIter FROM logo_concepts WHERE project_id = ?1`,
  )
    .bind(projectId)
    .first<{ maxIter: number }>();
  const iteration = (iterRow?.maxIter ?? 0) + 1;

  logger.info('generate.start', { projectId, iteration, concepts: concepts.length });

  // Generate images in bounded parallel
  const generated: LogoConcept[] = [];
  const chunkSize = 3;
  for (let i = 0; i < concepts.length; i += chunkSize) {
    const chunk = concepts.slice(i, i + chunkSize);
    const settled = await Promise.allSettled(
      chunk.map((c) => generateOne(env, c, projectId, iteration)),
    );
    for (const s of settled) {
      if (s.status === 'fulfilled') generated.push(s.value);
      else logger.warn('concept.failed', { reason: String(s.reason) });
    }
  }

  if (generated.length === 0) {
    throw new AgentError('All concept generations failed.', { code: 'upstream_failure' });
  }

  logger.info('generate.done', { succeeded: generated.length, requested: concepts.length });

  return {
    ok: true,
    projectId,
    iteration,
    brief,
    concepts: generated,
  };
}

// ── Brief extraction + prompt authoring (single LLM call) ────────────────────

const BRIEF_SYSTEM = `You extract a logo design brief from an interview transcript,
then author concrete image-generation prompts for diverse concepts.

Output strict JSON — no prose, no markdown:
{
  "brief": {
    "companyName": "string",
    "tagline": "string | null",
    "industry": "string",
    "audience": "string",
    "moodWords": ["3-5 adjectives"],
    "colorPreferences": ["optional color names/hex"],
    "inspirations": ["competitors or design references"],
    "avoid": ["things to exclude"]
  },
  "concepts": [
    { "style": "mark|wordmark|combo|lettermark|emblem", "prompt": "..." }
  ]
}

Prompt-authoring rules:
- Each prompt targets a 1024x1024 logo on a clean white background.
- Specify: mark subject (for mark/combo/emblem), color palette, mood, typography
  family hint (for wordmark/combo/lettermark), and composition.
- Vary concepts across literal vs abstract, geometric vs organic, serif vs sans.
- Prompts end with: "vector illustration, flat design, high contrast, crisp edges,
  centered, logo only, no text except the company name, no watermark".
- If companyName is unknown, use a placeholder "[Brand]".`;

async function extractBriefAndPrompts(
  llm: LLMClient,
  history: ChatRow[],
  count: number,
  styles: LogoStyle[],
): Promise<BriefAndPrompts> {
  const transcript = history
    .map((r) => `${r.role.toUpperCase()}: ${r.content}`)
    .join('\n\n');

  const userPrompt = `Interview transcript:\n\n${transcript}\n\nProduce ${count} concepts using these styles (distribute across them): ${styles.join(', ')}.`;

  const res = await llm.complete({
    tier: 'deep',
    system: BRIEF_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const parsed = parseJsonObject(res.text);
  const brief = normaliseBrief(parsed.brief);
  const concepts = Array.isArray(parsed.concepts)
    ? (parsed.concepts as unknown[])
        .map((c) => {
          const obj = c as { style?: string; prompt?: string };
          if (!obj.prompt || !obj.style) return null;
          if (!['mark', 'wordmark', 'combo', 'lettermark', 'emblem'].includes(obj.style)) return null;
          return { style: obj.style as LogoStyle, prompt: obj.prompt };
        })
        .filter((c): c is ConceptDraft => c !== null)
    : [];

  if (concepts.length === 0) {
    throw new AgentError('LLM returned no valid concepts.', { code: 'tool_failure' });
  }

  return { brief, concepts };
}

function normaliseBrief(input: unknown): DesignBrief {
  const b = (input ?? {}) as Partial<DesignBrief>;
  return {
    companyName: typeof b.companyName === 'string' ? b.companyName : '[Brand]',
    tagline: typeof b.tagline === 'string' ? b.tagline : null,
    industry: typeof b.industry === 'string' ? b.industry : '',
    audience: typeof b.audience === 'string' ? b.audience : '',
    moodWords: Array.isArray(b.moodWords) ? b.moodWords.filter((s): s is string => typeof s === 'string') : [],
    colorPreferences: Array.isArray(b.colorPreferences)
      ? b.colorPreferences.filter((s): s is string => typeof s === 'string')
      : [],
    inspirations: Array.isArray(b.inspirations)
      ? b.inspirations.filter((s): s is string => typeof s === 'string')
      : [],
    avoid: Array.isArray(b.avoid) ? b.avoid.filter((s): s is string => typeof s === 'string') : [],
  };
}

// ── Per-concept generation ─────────────────────────────────────────────────

async function generateOne(
  env: Env,
  concept: ConceptDraft,
  projectId: string,
  iteration: number,
): Promise<LogoConcept> {
  const res = await fetch(OPENAI_IMAGES_API, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: concept.prompt,
      size: '1024x1024',
      n: 1,
    }),
  });

  if (!res.ok) {
    throw new AgentError(`OpenAI image gen failed (${res.status}): ${await res.text()}`, {
      code: 'upstream_failure',
    });
  }

  const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const first = json.data?.[0];
  if (!first) throw new AgentError('OpenAI returned empty data.', { code: 'upstream_failure' });

  let bytes: Uint8Array;
  if (first.b64_json) {
    bytes = base64ToBytes(first.b64_json);
  } else if (first.url) {
    const imgRes = await fetch(first.url);
    bytes = new Uint8Array(await imgRes.arrayBuffer());
  } else {
    throw new AgentError('OpenAI response missing image.', { code: 'upstream_failure' });
  }

  const conceptId = `cnc_${crypto.randomUUID()}`;
  const r2Key = `logo-concepts/${projectId}/${iteration}/${conceptId}.png`;
  await env.BUCKET.put(r2Key, bytes, {
    httpMetadata: { contentType: 'image/png' },
    customMetadata: { style: concept.style, iteration: String(iteration) },
  });

  await env.DB.prepare(
    `INSERT INTO logo_concepts
       (id, project_id, iteration, style, prompt, image_r2_key, preview_url, selected, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)`,
  )
    .bind(conceptId, projectId, iteration, concept.style, concept.prompt, r2Key, `r2://${r2Key}`, Date.now())
    .run();

  return {
    id: conceptId,
    iteration,
    style: concept.style,
    prompt: concept.prompt,
    previewUrl: `r2://${r2Key}`,
    r2Key,
  };
}

// ── Project upsert ─────────────────────────────────────────────────────────

async function upsertLogoProject(
  db: D1Database,
  input: { userId: string; sessionId: string; name: string; brief: DesignBrief },
): Promise<string> {
  const existing = await db
    .prepare(
      `SELECT id FROM projects
        WHERE user_id = ?1 AND kind = 'logo'
          AND metadata LIKE ?2
        LIMIT 1`,
    )
    .bind(input.userId, `%"sessionId":"${input.sessionId}"%`)
    .first<{ id: string }>();

  const now = Date.now();
  if (existing) {
    await db
      .prepare(`UPDATE projects SET updated_at = ?1 WHERE id = ?2`)
      .bind(now, existing.id)
      .run();
    return existing.id;
  }

  const id = `prj_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO projects
         (id, user_id, name, kind, status, metadata, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'logo', 'planning', ?4, ?5, ?5)`,
    )
    .bind(
      id,
      input.userId,
      input.name,
      JSON.stringify({ sessionId: input.sessionId, brief: input.brief }),
      now,
    )
    .run();
  return id;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1) {
    throw new AgentError('Brief extractor did not return JSON.', { code: 'tool_failure' });
  }
  try {
    return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>;
  } catch (err) {
    throw new AgentError(
      `Brief JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'tool_failure' },
    );
  }
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
