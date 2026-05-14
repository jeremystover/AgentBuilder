/**
 * Auto-categorization for raw_transactions. Two paths:
 *   1. Rule matching — load active rules, try to match by description/merchant/
 *      account/amount. First match wins; sets classification_method='rule',
 *      ai_confidence=1.0 (rules are deterministic).
 *   2. AI classification — for rows with no rule match, call @agentbuilder/llm
 *      with the row's context + categories + entity hints. Persist the
 *      returned entity/category/confidence/reasoning to the raw row.
 *
 * Both paths leave status='staged' — they prepare a row for human review,
 * they never auto-approve. Approval lives in /api/web/review/:id/approve.
 *
 * Triggered after every Teller sync and email sync (src/index.ts cron),
 * and on demand via the classify tool.
 */

import type { Env } from '../types';
import { db, pgArr, type Sql } from './db';
import { LLMClient, type ModelTier } from '@agentbuilder/llm';

interface RawRow {
  id: string;
  account_id: string | null;
  account_entity_id: string | null;
  date: string;
  amount: number;
  description: string;
  merchant: string | null;
  supplement_json: Record<string, unknown> | null;
}

interface RuleRow {
  id: string;
  match_json: Record<string, unknown>;
  entity_id: string | null;
  category_id: string | null;
}

interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  entity_type: string;
  category_set: string;
  description: string | null;
}

interface EntityRow {
  id: string;
  name: string;
  type: string;
  slug: string;
}

export interface ClassifyResult {
  scanned: number;
  classified_by_rule: number;
  classified_by_ai: number;
  ai_failures: number;
}

const DEFAULT_AI_TIER: ModelTier = 'default';

export async function runClassify(env: Env, opts: { ids?: string[]; limit?: number; tier?: ModelTier } = {}): Promise<ClassifyResult> {
  const sql = db(env);
  try {
    const rows = await fetchUnclassified(sql, opts);
    if (rows.length === 0) {
      return { scanned: 0, classified_by_rule: 0, classified_by_ai: 0, ai_failures: 0 };
    }

    const [rules, categories, entities] = await Promise.all([
      fetchRules(sql),
      fetchCategories(sql),
      fetchEntities(sql),
    ]);

    let byRule = 0;
    let byAi = 0;
    let aiFailures = 0;

    const llm = env.ANTHROPIC_API_KEY ? new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY }) : null;

    for (const row of rows) {
      const rule = matchRule(row, rules);
      if (rule) {
        await applyRule(sql, row.id, rule);
        byRule++;
        continue;
      }
      if (!llm) {
        // No API key — skip AI step but don't fail the whole batch.
        continue;
      }
      try {
        const result = await classifyWithAi(llm, row, categories, entities, opts.tier ?? DEFAULT_AI_TIER);
        if (result) {
          await applyAi(sql, row.id, result);
          byAi++;
        } else {
          aiFailures++;
        }
      } catch (err) {
        console.warn('[classify] AI failed for', row.id, err);
        aiFailures++;
      }
    }

    return { scanned: rows.length, classified_by_rule: byRule, classified_by_ai: byAi, ai_failures: aiFailures };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function fetchUnclassified(sql: Sql, opts: { ids?: string[]; limit?: number }): Promise<RawRow[]> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const rows = await sql<Array<{
    id: string; account_id: string | null; account_entity_id: string | null;
    date: string; amount: string; description: string; merchant: string | null;
    supplement_json: unknown;
  }>>`
    SELECT r.id, r.account_id, a.entity_id AS account_entity_id,
           to_char(r.date, 'YYYY-MM-DD') AS date, r.amount::text AS amount,
           r.description, r.merchant, r.supplement_json
    FROM raw_transactions r
    LEFT JOIN gather_accounts a ON a.id = r.account_id
    WHERE r.status = 'staged'
      AND r.category_id IS NULL
      ${opts.ids && opts.ids.length > 0 ? sql`AND r.id = ANY(${pgArr(opts.ids)}::text[])` : sql``}
    ORDER BY r.ingest_at DESC
    LIMIT ${limit}
  `;
  return rows.map(r => ({
    id: r.id,
    account_id: r.account_id,
    account_entity_id: r.account_entity_id,
    date: r.date,
    amount: Number(r.amount),
    description: r.description,
    merchant: r.merchant,
    supplement_json: (r.supplement_json as Record<string, unknown> | null) ?? null,
  }));
}

async function fetchRules(sql: Sql): Promise<RuleRow[]> {
  return sql<RuleRow[]>`
    SELECT id, match_json, entity_id, category_id
    FROM rules
    WHERE is_active = true
    ORDER BY created_at DESC
  `;
}

async function fetchCategories(sql: Sql): Promise<CategoryRow[]> {
  return sql<CategoryRow[]>`
    SELECT id, slug, name, entity_type, category_set, description
    FROM categories
    WHERE is_active = true
    ORDER BY sort_order, name
  `;
}

async function fetchEntities(sql: Sql): Promise<EntityRow[]> {
  return sql<EntityRow[]>`SELECT id, name, type, slug FROM entities WHERE is_active = true`;
}

// ── Rules ────────────────────────────────────────────────────────────────────

export function matchRule(row: RawRow, rules: RuleRow[]): RuleRow | null {
  const desc = (row.description ?? '').toLowerCase();
  const merchant = (row.merchant ?? '').toLowerCase();
  for (const rule of rules) {
    const m = rule.match_json;
    if (typeof m.description_contains === 'string' && m.description_contains) {
      if (!desc.includes(String(m.description_contains).toLowerCase())) continue;
    }
    if (typeof m.description_starts_with === 'string' && m.description_starts_with) {
      if (!desc.startsWith(String(m.description_starts_with).toLowerCase())) continue;
    }
    if (typeof m.merchant_equals === 'string' && m.merchant_equals) {
      if (merchant !== String(m.merchant_equals).toLowerCase()) continue;
    }
    if (typeof m.amount_min === 'number' && row.amount < m.amount_min) continue;
    if (typeof m.amount_max === 'number' && row.amount > m.amount_max) continue;
    if (typeof m.account_id === 'string' && m.account_id !== row.account_id) continue;
    return rule;
  }
  return null;
}

async function applyRule(sql: Sql, rawId: string, rule: RuleRow): Promise<void> {
  await sql`
    UPDATE raw_transactions
    SET entity_id = ${rule.entity_id ?? null},
        category_id = ${rule.category_id ?? null},
        classification_method = 'rule',
        ai_confidence = 1.000,
        ai_notes = ${`Matched rule ${rule.id}`}
    WHERE id = ${rawId}
  `;
  await sql`UPDATE rules SET match_count = match_count + 1, last_matched_at = now() WHERE id = ${rule.id}`;
}

// ── AI ───────────────────────────────────────────────────────────────────────

interface AiResult {
  entity_id: string;
  category_id: string;
  confidence: number;
  reasoning: string;
}

async function classifyWithAi(
  llm: LLMClient,
  row: RawRow,
  categories: CategoryRow[],
  entities: EntityRow[],
  tier: ModelTier,
): Promise<AiResult | null> {
  const system = buildSystemPrompt(categories, entities);
  const user = buildUserPrompt(row, entities);

  const response = await llm.complete({
    tier,
    system,
    messages: [{ role: 'user', content: user }],
    maxOutputTokens: 800,
  });

  return parseAiResponse(response.text, categories, entities);
}

function buildSystemPrompt(categories: CategoryRow[], entities: EntityRow[]): string {
  const entityLines = entities.map(e => `- ${e.id} (${e.type}, ${e.slug}): ${e.name}`).join('\n');
  const categoryLines = categories
    .map(c => `- ${c.id} (${c.entity_type}/${c.category_set}, ${c.slug}): ${c.name}${c.description ? ' — ' + c.description : ''}`)
    .join('\n');

  return `You classify family-finance transactions for a household with two coaching businesses (Schedule C), one rental property (Schedule E), and personal/family budget.

Entities:
${entityLines}

Categories:
${categoryLines}

Rules:
- Pick ONE entity_id and ONE category_id from the lists above.
- The category's entity_type must match the entity's type (or be 'all'). Personal entity → personal or all categories. schedule_c → schedule_c or all. schedule_e → schedule_e or all.
- Internal transfers between owned accounts use category_id 'cat_transfer' with entity_id matching the source account's entity (or 'ent_personal').
- Respond in this exact JSON shape, nothing else:
  {"entity_id":"...","category_id":"...","confidence":0.0-1.0,"reasoning":"..."}
- confidence < 0.7 means a human should review carefully; pick the BEST guess anyway.
- Keep reasoning under 200 chars. Reference what features drove the decision.`;
}

function buildUserPrompt(row: RawRow, entities: EntityRow[]): string {
  const accountEntity = entities.find(e => e.id === row.account_entity_id);
  return JSON.stringify({
    date: row.date,
    amount: row.amount,
    description: row.description,
    merchant: row.merchant,
    account_entity_hint: accountEntity ? `${accountEntity.slug} (${accountEntity.type})` : null,
    supplement: row.supplement_json,
  }, null, 2);
}

function parseAiResponse(text: string, categories: CategoryRow[], entities: EntityRow[]): AiResult | null {
  // Strip code fences / leading prose if any.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const obj = parsed as Partial<AiResult>;
  if (typeof obj.entity_id !== 'string' || typeof obj.category_id !== 'string') return null;
  if (!entities.find(e => e.id === obj.entity_id)) return null;
  if (!categories.find(c => c.id === obj.category_id)) return null;
  const confidence = typeof obj.confidence === 'number'
    ? Math.max(0, Math.min(1, obj.confidence))
    : 0.5;
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning.slice(0, 800) : '';
  return { entity_id: obj.entity_id, category_id: obj.category_id, confidence, reasoning };
}

async function applyAi(sql: Sql, rawId: string, result: AiResult): Promise<void> {
  await sql`
    UPDATE raw_transactions
    SET entity_id = ${result.entity_id},
        category_id = ${result.category_id},
        classification_method = 'ai',
        ai_confidence = ${result.confidence},
        ai_notes = ${result.reasoning}
    WHERE id = ${rawId}
  `;
}
