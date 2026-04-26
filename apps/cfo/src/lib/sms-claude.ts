/**
 * Claude-driven free-text intent parser for SMS replies.
 *
 * Two entry points:
 *   - parseSmsIntent: single transaction. The user said something like
 *     "that was groceries" or "lyft to airport for the coaching trip" —
 *     we map it to (entity, category_tax, category_budget) with a
 *     confidence score and an `ambiguous` flag.
 *   - parseSmsBatch: 3-pack. The user replied addressing A/B/C —
 *     "A 1, B groceries, C ask jeremy" — and we return a per-label
 *     assignment vector.
 *
 * Both calls go through the existing Anthropic API path; we don't spin
 * up the @agentbuilder/llm package because we need:
 *   - Tight token budget (SMS context is small, replies are short)
 *   - A 10s AbortController timeout (Twilio gives us 15s end-to-end)
 *   - Structured tool output, not chat
 *
 * On any failure (timeout, bad parse, missing key) we throw and let the
 * inbound handler fall back to "I didn't catch that" — never silently
 * misclassify on the user's behalf.
 */

import type { Env } from '../types';
import { SCHEDULE_C_CATEGORIES, AIRBNB_CATEGORIES, FAMILY_CATEGORIES } from '../types';

const MODEL = 'claude-sonnet-4-6';
const TIMEOUT_MS = 10_000;

// ── Single ─────────────────────────────────────────────────────────────────

export interface SmsIntentInput {
  merchant: string | null;
  amount: number;
  date: string;
  description: string;
  reply_text: string;
  account_owner: string | null;
}

export interface SmsIntentResult {
  entity: 'elyse_coaching' | 'jeremy_coaching' | 'airbnb_activity' | 'family_personal';
  category_tax: string;
  category_budget: string;
  confidence: number;
  ambiguous: boolean;
  why: string;
}

const SINGLE_TOOL = {
  name: 'extract_intent',
  description: "Extract the user's intended classification for the transaction from their SMS reply.",
  input_schema: {
    type: 'object' as const,
    properties: {
      entity: {
        type: 'string',
        enum: ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'],
      },
      category_tax: {
        type: 'string',
        description: 'One of the valid tax codes for the entity (see system prompt). Empty string if family_personal and no clear tax tie.',
      },
      category_budget: {
        type: 'string',
        description: 'One of the valid budget codes (see system prompt). Empty string when not applicable.',
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      ambiguous: {
        type: 'boolean',
        description: 'True when the reply could plausibly mean multiple categories — set so the caller asks for clarification rather than auto-applying.',
      },
      why: {
        type: 'string',
        description: 'Short (≤80 chars) explanation of which words in the reply drove the choice.',
      },
    },
    required: ['entity', 'category_tax', 'category_budget', 'confidence', 'ambiguous', 'why'],
  },
};

const SYSTEM_BASE = `You parse short SMS replies into transaction classifications. The user is one of two non-accountants categorizing their own books. Their reply may be terse ("groceries"), conversational ("that was for the airbnb"), or contain typos. Be charitable about intent.

Entities and their valid category codes:
- elyse_coaching (Schedule C): ${Object.keys(SCHEDULE_C_CATEGORIES).join(', ')}
- jeremy_coaching (Schedule C): ${Object.keys(SCHEDULE_C_CATEGORIES).join(', ')}
- airbnb_activity (Schedule E): ${Object.keys(AIRBNB_CATEGORIES).join(', ')}
- family_personal: ${Object.keys(FAMILY_CATEGORIES).join(', ')} (use these for category_budget; category_tax should be empty)

Rules of thumb:
- "Whitford" / "rental" / "airbnb" / "guest" → airbnb_activity
- "coaching" / "client" / "course" → coaching (use account_owner to disambiguate elyse_coaching vs jeremy_coaching when possible; default to elyse_coaching if unclear)
- "groceries" / "food at home" → family_personal/groceries
- "dining" / "lunch" / "dinner out" → family_personal/dining_out (or meals if a clearly business meal)
- "ask jeremy" / "I don't know" / "skip" / single "?" → set ambiguous=true with confidence ≤ 0.3
- If confidence < 0.6 set ambiguous=true so the caller can re-confirm.`;

export async function parseSmsIntent(env: Env, input: SmsIntentInput): Promise<SmsIntentResult> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const userMessage = [
    `Transaction:`,
    `- Merchant: ${input.merchant ?? '(unknown)'}`,
    `- Amount: $${Math.abs(input.amount).toFixed(2)} (${input.amount < 0 ? 'expense' : 'income'})`,
    `- Date: ${input.date}`,
    `- Description: ${input.description}`,
    `- Account owner: ${input.account_owner ?? '(unknown)'}`,
    ``,
    `User reply:`,
    `"${input.reply_text}"`,
    ``,
    `Call extract_intent with the user's intended classification.`,
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        tools: [SINGLE_TOOL],
        tool_choice: { type: 'tool', name: 'extract_intent' },
        system: SYSTEM_BASE,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude SMS parse failed ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = (await res.json()) as { content: Array<{ type: string; name?: string; input?: SmsIntentResult }> };
  const tool = data.content.find((b) => b.type === 'tool_use' && b.name === 'extract_intent');
  if (!tool?.input) throw new Error('Claude returned no extract_intent tool call');
  return tool.input;
}

// ── Batch ──────────────────────────────────────────────────────────────────

export interface SmsBatchItem {
  label: 'A' | 'B' | 'C';
  merchant: string | null;
  amount: number;
  date: string;
  description: string;
  account_owner: string | null;
}

export type BatchAction = 'confirm' | 'set_category' | 'reroute' | 'skip';

export interface SmsBatchAssignment {
  label: 'A' | 'B' | 'C';
  action: BatchAction;
  /** Populated when action === 'set_category'. */
  entity?: SmsIntentResult['entity'];
  category_tax?: string;
  category_budget?: string;
  confidence: number;
  ambiguous: boolean;
}

const BATCH_TOOL = {
  name: 'parse_batch',
  description: "Parse the user's SMS reply into a per-label assignment for a 3-pack of transactions labeled A/B/C.",
  input_schema: {
    type: 'object' as const,
    properties: {
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', enum: ['A', 'B', 'C'] },
            action: { type: 'string', enum: ['confirm', 'set_category', 'reroute', 'skip'] },
            entity: {
              type: 'string',
              enum: ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'],
            },
            category_tax: { type: 'string' },
            category_budget: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            ambiguous: { type: 'boolean' },
          },
          required: ['label', 'action', 'confidence', 'ambiguous'],
        },
      },
    },
    required: ['assignments'],
  },
};

const BATCH_SYSTEM = `${SYSTEM_BASE}

You're parsing a reply addressing THREE labeled transactions (A, B, C). The reply may:
- Cover all three at once ("1" → action=confirm for all three)
- Cover them individually ("A 1, B groceries, C ask jeremy" → A=confirm, B=set_category, C=reroute)
- Cover only some — anything not addressed gets action=skip with confidence 0
- Use natural language ("the first two are groceries, last one I'm not sure" → A=set_category(groceries), B=set_category(groceries), C=reroute)

Action semantics:
- confirm: accept the system's pre-computed suggestion (no need to set entity/categories)
- set_category: user provided a category — populate entity + category_tax + category_budget
- reroute: user wants to send to Jeremy ("ask jeremy", "send to him", "2")
- skip: not addressed in the reply

Always return exactly three assignments, one per label, in A/B/C order.`;

export async function parseSmsBatch(
  env: Env,
  items: SmsBatchItem[],
  replyText: string,
): Promise<SmsBatchAssignment[]> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  if (items.length !== 3) {
    throw new Error('parseSmsBatch expects exactly 3 items');
  }

  const lines = items.map((it) =>
    `${it.label}: ${it.merchant ?? '(unknown)'} · $${Math.abs(it.amount).toFixed(2)} · ${it.date} · owner=${it.account_owner ?? '(unknown)'}`,
  );

  const userMessage = [
    `Transactions:`,
    ...lines,
    ``,
    `User reply:`,
    `"${replyText}"`,
    ``,
    `Call parse_batch with one assignment per label (A, B, C).`,
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        tools: [BATCH_TOOL],
        tool_choice: { type: 'tool', name: 'parse_batch' },
        system: BATCH_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude batch parse failed ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    content: Array<{ type: string; name?: string; input?: { assignments: SmsBatchAssignment[] } }>;
  };
  const tool = data.content.find((b) => b.type === 'tool_use' && b.name === 'parse_batch');
  if (!tool?.input?.assignments) throw new Error('Claude returned no parse_batch tool call');

  // Make sure we have exactly one assignment per label.
  const out: SmsBatchAssignment[] = [];
  for (const label of ['A', 'B', 'C'] as const) {
    const found = tool.input.assignments.find((a) => a.label === label);
    if (found) out.push(found);
    else out.push({ label, action: 'skip', confidence: 0, ambiguous: true });
  }
  return out;
}
