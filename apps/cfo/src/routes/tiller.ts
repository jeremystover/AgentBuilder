import type { Env } from '../types';
import { jsonOk, jsonError, getUserId } from '../types';
import { computeDedupHash, cleanDescription, parseCsv } from '../lib/dedup';

// ─────────────────────────────────────────────────────────────────────────────
// Tiller category → { entity, category_tax } mapping
//
// Tiller conventions found in this export:
//   c -  prefix  →  elyse_coaching  (Schedule C)
//   m -  prefix  →  airbnb_activity    (rental property, likely "main" house)
//   w -  prefix  →  airbnb_activity    (rental property, "w" property)
//   Sch C ...    →  elyse_coaching
//   (no prefix)  →  family_personal
// ─────────────────────────────────────────────────────────────────────────────

interface Mapping { entity: string; category_tax: string }
interface LearnedExample {
  description: string;
  fullDescription: string;
  account: string;
  rawCategory: string;
  mapping: Mapping;
}

// Coaching business — exact match on the part AFTER "c - "
const COACHING_MAP: Record<string, string> = {
  'advertising':                    'advertising',
  'bank fees':                      'other_expenses',
  'bank charges':                   'other_expenses',
  'books and publications':         'office_expense',
  'car & truck expenses':           'car_and_truck',
  'car and truck':                  'car_and_truck',
  'client gifts':                   'other_expenses',
  'commissions & fees':             'commissions_and_fees',
  'commissions and fees':           'commissions_and_fees',
  'contract labor':                 'contract_labor',
  'cost of goods sold':             'other_expenses',
  'dues & subscriptions':           'office_expense',
  'dues and subscriptions':         'office_expense',
  'gross receipts':                 'income',
  'gross receipts / yoga':          'income',
  'insurance':                      'insurance',
  'legal & professional svcs':      'legal_professional',
  'legal and professional':         'legal_professional',
  'meals & entertainment':          'meals',
  'meals and entertainment':        'meals',
  'office expenses':                'office_expense',
  'office supplies':                'office_expense',
  'other expenses':                 'other_expenses',
  'other interest':                 'interest_other',
  'parking and tolls':              'other_expenses',
  'ppp loan':                       'income',
  'professional development':       'other_expenses',
  'public transportation & cabs':   'travel',
  'public transportation':          'travel',
  'rent or lease':                  'rent_lease_property',
  'repairs and maintenance':        'repairs_maintenance',
  'supplies':                       'supplies',
  'taxes & licences':               'taxes_licenses',
  'taxes and licenses':             'taxes_licenses',
  'travel':                         'travel',
  'utilities':                      'utilities',
};

// Rental / Airbnb — exact match on the part AFTER "m - " or "w - "
const RENTAL_MAP: Record<string, string> = {
  'utilities':                      'utilities_rental',
  'bank fees':                      'other_rental',
  'bank fees and closing costs':    'other_rental',
  'insurance':                      'insurance_rental',
  'mortgage':                       'mortgage_interest',
  'mortgage principle':             'mortgage_interest',
  'other income':                   'rental_income',
  'rental income':                  'rental_income',
  'rental income - guest house':    'rental_income',
  'rental income - main house':     'rental_income',
  'professional services':          'legal_professional_r',
  'property tax':                   'taxes_rental',
  'public transportation':          'auto_travel',
  'repairs and maintenance':        'repairs_rental',
  'repairs':                        'repairs_rental',
  'security deposit':               'other_rental',
  'capital investments':            'other_rental',
  'depreciation (furniture)':       'depreciation_rental',
  'furniture':                      'other_rental',
  'interest':                       'other_interest',
  'investment':                     'other_rental',
  'moving expenses':                'other_rental',
  'advertising':                    'advertising_rental',
  'travel':                         'auto_travel',
  'management fees':                'management_fees',
  'supplies':                       'supplies_rental',
  'taxes':                          'taxes_rental',
};

// Family/personal — full category name → budget category_tax
const FAMILY_MAP: Record<string, string> = {
  // Food
  'groceries':             'groceries',
  'food & dining':         'dining_out',
  'restaurants':           'dining_out',
  'coffee':                'dining_out',
  'coffee shops':          'dining_out',
  'jeremy - lunch':        'dining_out',
  // Entertainment
  'entertainment':         'entertainment',
  'movies & dvds':         'entertainment',
  'movies, media':         'entertainment',
  'amusement':             'entertainment',
  'hobbies':               'entertainment',
  'music':                 'entertainment',
  'sports':                'entertainment',
  'books & supplies':      'education',
  // Healthcare
  'medical':               'healthcare',
  'doctor':                'healthcare',
  'dentist':               'healthcare',
  'health & fitness':      'healthcare',
  'eyecare':               'healthcare',
  'gym':                   'personal_care',
  'gym, exercise classes': 'personal_care',
  // Housing
  'mortgage':              'housing',
  'mortgage payment':      'housing',
  'home services':         'housing',
  'misc - home':           'housing',
  'large expense - home':  'housing',
  'home improvements':     'housing',
  'homeowners insurance':  'housing',
  'utilities':             'subscriptions',
  'phone':                 'subscriptions',
  // Transportation
  'travel':                'transportation',
  'vacation':              'transportation',
  'air travel':            'transportation',
  'hotel':                 'transportation',
  'rental car & taxi':     'transportation',
  'local taxi':            'transportation',
  'local transportation':  'transportation',
  'parking':               'transportation',
  'public transportation': 'transportation',
  'auto & gas':            'transportation',
  'service & parts':       'transportation',
  'business travel':       'transportation',
  // Education
  'education':             'education',
  // Personal care
  'personal care':         'personal_care',
  'hair':                  'personal_care',
  'massage & hair':        'personal_care',
  'spa & massage':         'personal_care',
  // Shopping
  'clothing':              'shopping',
  'shopping':              'shopping',
  'amazon':                'shopping',
  'electronics':           'shopping',
  'electronics & software':'shopping',
  'furnishings':           'shopping',
  'gear & clothing':       'shopping',
  'stuff':                 'shopping',
  'toys':                  'shopping',
  'office supplies':       'shopping',
  // Charity
  'charity':               'charitable_giving',
  'charity - cash donations': 'charitable_giving',
  'charity - in kind':     'charitable_giving',
  'gifts':                 'charitable_giving',
  'gift':                  'other_personal',
  'gifts to us':           'other_personal',
  // Taxes (potentially deductible)
  'taxes':                 'potentially_deductible',
  'taxes paid':            'potentially_deductible',
  'property tax':          'potentially_deductible',
  'sales tax':             'potentially_deductible',
  'misc taxes and fees':   'potentially_deductible',
  'insurance':             'potentially_deductible',
  'legal':                 'potentially_deductible',
  'fees & charges':        'potentially_deductible',
  'finance charge':        'potentially_deductible',
  // Kids
  'kids activities':       'other_personal',
  'kids fun':              'other_personal',
  'kids stuff':            'other_personal',
  'babysitter & daycare':  'other_personal',
  'childcare, camps, classes': 'other_personal',
  // Pets
  'dog stuff':             'other_personal',
  'pet / lola':            'other_personal',
  // Other
  'service fee':           'other_personal',
  'business services':     'other_personal',
  'business software':     'subscriptions',
  'elyse - venmo':         'other_personal',
  'repairs':               'housing',
  'j - job related non-reimbursed': 'potentially_deductible',
};

// Categories to skip entirely (transfers, payments, internal moves)
const SKIP_CATEGORIES = new Set([
  'transfer', 'transer', 'transfer - income', 'credit card payment',
  'check', 'paypal', 'reimbursement', 'reimbursable', 'reimbursable - gps',
  'returned purchase', 'refund', 'hide from budgets & trends',
  'investments', 'investment', 'paycheck', 'bonus', 'ca income',
  'income', 'elyse paycheck', 'elyse income', 'freelance',
  'dividend/interest', 'interest income', 'cash', 'nov',
  'payment 3 of 4.', 'payment 4 or 4.',
]);

// Income categories that should be marked as income
const INCOME_CATEGORIES = new Set([
  'paycheck', 'bonus', 'ca income', 'elyse paycheck', 'elyse income',
  'freelance', 'dividend/interest', 'interest income',
]);

const GENERIC_RULE_PATTERNS = new Set([
  'payment',
  'payment thank you',
  'online payment',
  'automatic payment',
  'transfer',
  'interest payment',
  'deposit',
  'withdrawal',
  'purchase',
  'debit card purchase',
  'pos purchase',
]);

export function mapCategory(raw: string): Mapping | null {
  const cat = raw.trim();
  const lower = cat.toLowerCase();

  // Skip transfers/payments
  if (SKIP_CATEGORIES.has(lower)) return null;

  // --- elyse_coaching (c - prefix) ---
  if (lower.startsWith('c - ') || lower.startsWith('c-')) {
    const suffix = lower.replace(/^c\s*-\s*/, '').trim();
    const taxCat = COACHING_MAP[suffix] ?? 'other_expenses';
    return { entity: 'elyse_coaching', category_tax: taxCat };
  }

  // "Sch C ..." variants
  if (lower.startsWith('sch c ')) {
    const suffix = lower.replace(/^sch c\s*/, '').trim();
    const taxCat = COACHING_MAP[suffix] ?? 'other_expenses';
    return { entity: 'elyse_coaching', category_tax: taxCat };
  }

  // --- airbnb_activity (m - or w - prefix) ---
  if (lower.startsWith('m - ') || lower.startsWith('m-')) {
    const suffix = lower.replace(/^m\s*-\s*/, '').trim();
    const taxCat = RENTAL_MAP[suffix] ?? 'other_rental';
    return { entity: 'airbnb_activity', category_tax: taxCat };
  }

  if (lower.startsWith('w - ') || lower.startsWith('w-')) {
    const suffix = lower.replace(/^w\s*-\s*/, '').trim();
    const taxCat = RENTAL_MAP[suffix] ?? 'other_rental';
    return { entity: 'airbnb_activity', category_tax: taxCat };
  }

  // --- family_personal ---
  const familyCat = FAMILY_MAP[lower];
  if (familyCat) return { entity: 'family_personal', category_tax: familyCat };

  // Fallback: keep as family/personal / other
  if (lower) return { entity: 'family_personal', category_tax: 'other_personal' };

  return null;
}

function parseAmount(raw: string): number {
  // Handles "$1,234.56", "-$1,234.56", "1234.56", "-1234.56"
  return parseFloat(raw.replace(/[$,\s]/g, '')) || 0;
}

function parseDate(raw: string): string {
  // M/D/YYYY → YYYY-MM-DD
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return raw.trim();
}

function normalizeRulePattern(raw: string): string {
  return cleanDescription(raw)
    .replace(/\b(?:llc|inc|corp|company|co|store|online|purchase|debit|credit|card|payment|checkcard)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulRulePattern(pattern: string): boolean {
  if (!pattern || pattern.length < 4) return false;
  if (GENERIC_RULE_PATTERNS.has(pattern)) return false;
  if (/^\d+$/.test(pattern)) return false;
  const alphaChars = pattern.replace(/[^a-z]/g, '').length;
  return alphaChars >= 4;
}

async function createLearnedRules(
  env: Env,
  userId: string,
  examples: LearnedExample[],
): Promise<{ created: number; skippedAmbiguous: number }> {
  const groups = new Map<string, {
    total: number;
    accounts: Set<string>;
    rawCategories: Map<string, number>;
    mappings: Map<string, { count: number; example: LearnedExample }>;
  }>();

  for (const example of examples) {
    const pattern = normalizeRulePattern(example.description);
    if (!isUsefulRulePattern(pattern)) continue;

    const group = groups.get(pattern) ?? {
      total: 0,
      accounts: new Set<string>(),
      rawCategories: new Map<string, number>(),
      mappings: new Map<string, { count: number; example: LearnedExample }>(),
    };

    group.total++;
    if (example.account) group.accounts.add(example.account);
    group.rawCategories.set(example.rawCategory, (group.rawCategories.get(example.rawCategory) ?? 0) + 1);

    const mappingKey = `${example.mapping.entity}|${example.mapping.category_tax}`;
    const existing = group.mappings.get(mappingKey);
    if (existing) {
      existing.count++;
    } else {
      group.mappings.set(mappingKey, { count: 1, example });
    }

    groups.set(pattern, group);
  }

  let created = 0;
  let skippedAmbiguous = 0;

  for (const [pattern, group] of groups.entries()) {
    if (group.total < 3) continue;

    const dominant = [...group.mappings.entries()].sort((a, b) => b[1].count - a[1].count)[0];
    if (!dominant) continue;

    const [mappingKey, info] = dominant;
    const dominance = info.count / group.total;
    if (info.count < 3 || dominance < 0.9) {
      skippedAmbiguous++;
      continue;
    }

    const [entity, categoryTax] = mappingKey.split('|');
    const topRawCategory = [...group.rawCategories.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? info.example.rawCategory;
    const accountNote = group.accounts.size === 1 ? ` (${[...group.accounts][0]})` : '';
    const ruleName = `Tiller learned: ${info.example.description}${accountNote} -> ${topRawCategory}`;
    const priority = Math.min(95, 60 + info.count);

    const existing = await env.DB.prepare(
      `SELECT id FROM rules
       WHERE user_id = ?
         AND match_field = 'description'
         AND match_operator = 'contains'
         AND lower(match_value) = lower(?)
         AND entity = ?
         AND COALESCE(category_tax, '') = COALESCE(?, '')`,
    ).bind(userId, pattern, entity, categoryTax).first();

    if (existing) continue;

    await env.DB.prepare(
      `INSERT INTO rules
         (id, user_id, name, match_field, match_operator, match_value, entity, category_tax, category_budget, priority, is_active)
       VALUES (?, ?, ?, 'description', 'contains', ?, ?, ?, null, ?, 1)`,
    ).bind(
      crypto.randomUUID(),
      userId,
      ruleName,
      pattern,
      entity,
      categoryTax,
      priority,
    ).run();

    created++;
  }

  return { created, skippedAmbiguous };
}

// ── POST /imports/tiller ──────────────────────────────────────────────────────
export async function handleTillerImport(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let formData: FormData;
  try { formData = await request.formData(); }
  catch { return jsonError('Expected multipart/form-data with a "file" field'); }

  const fileField = formData.get('file');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!fileField || typeof (fileField as any).text !== 'function') {
    return jsonError('"file" field is required');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const csvText = await (fileField as any).text() as string;
  const rows = parseCsv(csvText);

  if (!rows.length) return jsonError('CSV is empty or has no data rows');

  // Detect Tiller columns (case-insensitive)
  const sample = rows[0];
  const keys = Object.keys(sample).map(k => k.toLowerCase().trim());
  const hasDate     = keys.some(k => k === 'date');
  const hasCategory = keys.some(k => k === 'category');
  const hasAmount   = keys.some(k => k === 'amount');
  if (!hasDate || !hasCategory || !hasAmount) {
    return jsonError('File does not appear to be a Tiller export. Expected columns: Date, Description, Category, Amount.');
  }

  const importId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO imports (id, user_id, source, status, transactions_found) VALUES (?, ?, 'csv', 'running', ?)`,
  ).bind(importId, userId, rows.length).run();

  let imported = 0;
  let skipped = 0;
  let dupes = 0;
  const unmapped: string[] = [];
  const learnedExamples: LearnedExample[] = [];

  for (const row of rows) {
    // Normalize keys
    const get = (k: string) => row[k] ?? row[k.toLowerCase()] ?? row[Object.keys(row).find(rk => rk.toLowerCase() === k.toLowerCase()) ?? ''] ?? '';

    const rawDate     = get('date');
    const description = get('description').trim();
    const fullDescription = (get('full_description') || get('full description') || description).trim();
    const rawCategory = get('category').trim();
    const rawAmount   = get('amount');
    const account     = get('account').trim();

    if (!rawDate || !rawAmount || !(description || fullDescription)) { skipped++; continue; }

    const postedDate = parseDate(rawDate);
    if (!postedDate.match(/^\d{4}-\d{2}-\d{2}/)) { skipped++; continue; }

    const amount = parseAmount(rawAmount);
    if (isNaN(amount) || amount === 0) { skipped++; continue; }

    const mapping = mapCategory(rawCategory);
    if (!mapping) {
      // Skip transfers/payments silently
      const lower = rawCategory.toLowerCase();
      if (!SKIP_CATEGORIES.has(lower) && rawCategory && !unmapped.includes(rawCategory)) {
        unmapped.push(rawCategory);
      }
      skipped++;
      continue;
    }

    learnedExamples.push({
      description: description || fullDescription,
      fullDescription,
      account,
      rawCategory,
      mapping,
    });

    const merchantName = description || fullDescription;
    const storedDescription = fullDescription || description;
    const descClean  = cleanDescription(`${merchantName} ${storedDescription}`);
    const dedupHash  = await computeDedupHash(`tiller-${userId}-${account}`, postedDate, amount, merchantName);

    const txId = crypto.randomUUID();
    const txResult = await env.DB.prepare(
       `INSERT OR IGNORE INTO transactions
         (id, user_id, import_id, posted_date, amount, currency,
          merchant_name, description, description_clean, category_plaid, dedup_hash)
       VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?)`,
    ).bind(
      txId, userId, importId, postedDate, amount,
      merchantName, storedDescription, descClean, rawCategory, dedupHash,
    ).run();

    if (txResult.meta.changes === 0) { dupes++; continue; }

    // Immediately store the historical classification
    const classId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO classifications
         (id, transaction_id, entity, category_tax, confidence, method, reason_codes, review_required, classified_by)
       VALUES (?, ?, ?, ?, 1.0, 'historical', '["tiller_import"]', 0, 'tiller')`,
    ).bind(classId, txId, mapping.entity, mapping.category_tax).run();

    imported++;
  }

  const learnedRules = await createLearnedRules(env, userId, learnedExamples);

  await env.DB.prepare(
    `UPDATE imports SET status='completed', transactions_imported=?, transactions_found=?, completed_at=datetime('now') WHERE id=?`,
  ).bind(imported, rows.length, importId).run();

  return jsonOk({
    import_id: importId,
    total_rows: rows.length,
    transactions_imported: imported,
    duplicates_skipped: dupes,
    non_transaction_skipped: skipped - dupes,
    unmapped_categories: unmapped.slice(0, 20),
    learned_rules_created: learnedRules.created,
    ambiguous_rule_groups_skipped: learnedRules.skippedAmbiguous,
    message: imported > 0
      ? `Imported ${imported} classified transactions and learned ${learnedRules.created} reusable rules from repeated labeled merchants.`
      : 'No new transactions imported.',
  }, 201);
}
