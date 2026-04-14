import type { Env, Entity } from '../types';

const MIN_CONSISTENT_MANUALS = 3;
const MIN_DOMINANCE = 0.9;
const LEARNED_RULE_PRIORITY = 85;

const GENERIC_MERCHANT_PATTERNS = [
  'amazon',
  'amzn',
  'paypal',
  'venmo',
  'zelle',
  'square',
  'stripe',
  'apple cash',
  'cash app',
  'online payment',
  'payment',
  'deposit',
  'withdrawal',
  'transfer',
  'purchase',
  'debit',
  'credit',
];

function normalizeMerchant(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ');
}

function isSpecificMerchant(merchant: string): boolean {
  const normalized = merchant.toLowerCase();
  if (normalized.length < 4) return false;
  if (!/[a-z]/.test(normalized)) return false;
  return !GENERIC_MERCHANT_PATTERNS.some(pattern => normalized.includes(pattern));
}

interface ManualMerchantStats {
  entity: Entity;
  category_tax: string | null;
  category_budget: string | null;
  count: number;
}

export async function maybeLearnRuleFromManualClassification(
  env: Env,
  userId: string,
  txId: string,
  classification: {
    entity: Entity;
    category_tax: string;
    category_budget?: string | null;
  },
): Promise<{ created: boolean; ruleId?: string }> {
  const tx = await env.DB.prepare(
    `SELECT merchant_name
     FROM transactions
     WHERE id = ? AND user_id = ?`,
  ).bind(txId, userId).first<{ merchant_name: string | null }>();

  const merchant = normalizeMerchant(tx?.merchant_name);
  if (!isSpecificMerchant(merchant)) return { created: false };

  const stats = await env.DB.prepare(
    `SELECT c.entity, c.category_tax, c.category_budget, COUNT(*) AS count
     FROM transactions t
     JOIN classifications c ON c.transaction_id = t.id
     WHERE t.user_id = ?
       AND c.method = 'manual'
       AND lower(trim(COALESCE(t.merchant_name, ''))) = lower(?)
     GROUP BY c.entity, c.category_tax, c.category_budget`,
  ).bind(userId, merchant).all<ManualMerchantStats>();

  const totalManuals = stats.results.reduce((sum, row) => sum + row.count, 0);
  const consistent = stats.results.find(row =>
    row.entity === classification.entity
    && (row.category_tax ?? null) === classification.category_tax
    && (row.category_budget ?? null) === (classification.category_budget ?? null),
  )?.count ?? 0;

  if (consistent < MIN_CONSISTENT_MANUALS) return { created: false };
  if (!totalManuals || consistent / totalManuals < MIN_DOMINANCE) return { created: false };

  const existing = await env.DB.prepare(
    `SELECT id
     FROM rules
     WHERE user_id = ?
       AND match_field = 'merchant_name'
       AND match_operator = 'equals'
       AND lower(match_value) = lower(?)`,
  ).bind(userId, merchant).first<{ id: string }>();

  if (existing) return { created: false, ruleId: existing.id };

  const ruleId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO rules
       (id, user_id, name, match_field, match_operator, match_value, entity, category_tax, category_budget, priority, is_active)
     VALUES (?, ?, ?, 'merchant_name', 'equals', ?, ?, ?, ?, ?, 1)`,
  ).bind(
    ruleId,
    userId,
    `Learned from manual: ${merchant}`,
    merchant,
    classification.entity,
    classification.category_tax,
    classification.category_budget ?? null,
    LEARNED_RULE_PRIORITY,
  ).run();

  return { created: true, ruleId };
}
