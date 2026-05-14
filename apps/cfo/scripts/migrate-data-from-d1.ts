#!/usr/bin/env tsx
/**
 * One-shot migration: bring transactions, classifications, rules, and
 * splits from the legacy CFO D1 over to the new Neon schema.
 *
 * Two modes:
 *   --mode template   produce scripts/d1-category-map.json with best-guess
 *                     mappings from your old tax/budget category slugs to
 *                     the new seed slugs (review/edit before --mode migrate).
 *   --mode migrate    produce scripts/d1-migration.sql from all inputs +
 *                     the (now-edited) d1-category-map.json.
 *
 * Run from `apps/cfo`. See docs/migrate-data-from-d1.md for the export
 * commands and overall flow.
 *
 * NEVER commit the JSONs or .sql — they contain personal financial data.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

// ─── Hardcoded mappings ──────────────────────────────────────────────────

const OWNER_TAG_TO_ENTITY_ID: Record<string, string> = {
  elyse_coaching:  'ent_elyse_coaching',
  jeremy_coaching: 'ent_jeremy_coaching',
  airbnb_activity: 'ent_whitford',
  family_personal: 'ent_personal',
};

// Keep in sync with apps/cfo/migrations/0003_seed_categories.sql.
const NEW_TAX_CATS = [
  { id: 'cat_sc_gross_receipts', slug: 'sc_gross_receipts', name: 'Gross receipts',           set: 'schedule_c', line: 'I-1'  },
  { id: 'cat_sc_returns',        slug: 'sc_returns',        name: 'Returns and allowances',   set: 'schedule_c', line: 'I-2'  },
  { id: 'cat_sc_advertising',    slug: 'sc_advertising',    name: 'Advertising',              set: 'schedule_c', line: 'II-8'  },
  { id: 'cat_sc_car',            slug: 'sc_car',            name: 'Car and truck expenses',   set: 'schedule_c', line: 'II-9'  },
  { id: 'cat_sc_commissions',    slug: 'sc_commissions',    name: 'Commissions and fees',     set: 'schedule_c', line: 'II-10' },
  { id: 'cat_sc_contract',       slug: 'sc_contract',       name: 'Contract labor',           set: 'schedule_c', line: 'II-11' },
  { id: 'cat_sc_depreciation',   slug: 'sc_depreciation',   name: 'Depreciation',             set: 'schedule_c', line: 'II-13' },
  { id: 'cat_sc_insurance',      slug: 'sc_insurance',      name: 'Insurance (other than health)', set: 'schedule_c', line: 'II-15' },
  { id: 'cat_sc_interest',       slug: 'sc_interest',       name: 'Interest',                 set: 'schedule_c', line: 'II-16' },
  { id: 'cat_sc_legal',          slug: 'sc_legal',          name: 'Legal and professional',   set: 'schedule_c', line: 'II-17' },
  { id: 'cat_sc_office',         slug: 'sc_office',         name: 'Office expense',           set: 'schedule_c', line: 'II-18' },
  { id: 'cat_sc_pension',        slug: 'sc_pension',        name: 'Pension and profit-sharing', set: 'schedule_c', line: 'II-19' },
  { id: 'cat_sc_rent_vehicle',   slug: 'sc_rent_vehicle',   name: 'Rent - vehicles/equipment',set: 'schedule_c', line: 'II-20a' },
  { id: 'cat_sc_rent_other',     slug: 'sc_rent_other',     name: 'Rent - other property',    set: 'schedule_c', line: 'II-20b' },
  { id: 'cat_sc_repairs',        slug: 'sc_repairs',        name: 'Repairs and maintenance',  set: 'schedule_c', line: 'II-21' },
  { id: 'cat_sc_supplies',       slug: 'sc_supplies',       name: 'Supplies',                 set: 'schedule_c', line: 'II-22' },
  { id: 'cat_sc_taxes',          slug: 'sc_taxes',          name: 'Taxes and licenses',       set: 'schedule_c', line: 'II-23' },
  { id: 'cat_sc_travel',         slug: 'sc_travel',         name: 'Travel',                   set: 'schedule_c', line: 'II-24a' },
  { id: 'cat_sc_meals',          slug: 'sc_meals',          name: 'Meals',                    set: 'schedule_c', line: 'II-24b' },
  { id: 'cat_sc_utilities',      slug: 'sc_utilities',      name: 'Utilities',                set: 'schedule_c', line: 'II-25' },
  { id: 'cat_sc_wages',          slug: 'sc_wages',          name: 'Wages',                    set: 'schedule_c', line: 'II-26' },
  { id: 'cat_sc_other',          slug: 'sc_other',          name: 'Other expenses',           set: 'schedule_c', line: 'II-27a' },
  { id: 'cat_sc_development',    slug: 'sc_development',    name: 'Professional development', set: 'schedule_c', line: 'II-27a' },
  { id: 'cat_sc_home_office',    slug: 'sc_home_office',    name: 'Home office',              set: 'schedule_c', line: 'II-30' },
  { id: 'cat_se_rents',          slug: 'se_rents',          name: 'Rents received',           set: 'schedule_e', line: 'I-3a' },
  { id: 'cat_se_royalties',      slug: 'se_royalties',      name: 'Royalties received',      set: 'schedule_e', line: 'I-4'  },
  { id: 'cat_se_advertising',    slug: 'se_advertising',    name: 'Advertising',             set: 'schedule_e', line: 'I-5'  },
  { id: 'cat_se_auto_travel',    slug: 'se_auto_travel',    name: 'Auto and travel',         set: 'schedule_e', line: 'I-6'  },
  { id: 'cat_se_cleaning',       slug: 'se_cleaning',       name: 'Cleaning and maintenance',set: 'schedule_e', line: 'I-7'  },
  { id: 'cat_se_commissions',    slug: 'se_commissions',    name: 'Commissions',             set: 'schedule_e', line: 'I-8'  },
  { id: 'cat_se_insurance',      slug: 'se_insurance',      name: 'Insurance',               set: 'schedule_e', line: 'I-9'  },
  { id: 'cat_se_legal',          slug: 'se_legal',          name: 'Legal and professional',  set: 'schedule_e', line: 'I-10' },
  { id: 'cat_se_management',     slug: 'se_management',     name: 'Management fees',         set: 'schedule_e', line: 'I-11' },
  { id: 'cat_se_mortgage_interest', slug: 'se_mortgage_interest', name: 'Mortgage interest', set: 'schedule_e', line: 'I-12' },
  { id: 'cat_se_other_interest', slug: 'se_other_interest', name: 'Other interest',          set: 'schedule_e', line: 'I-13' },
  { id: 'cat_se_repairs',        slug: 'se_repairs',        name: 'Repairs',                 set: 'schedule_e', line: 'I-14' },
  { id: 'cat_se_supplies',       slug: 'se_supplies',       name: 'Supplies',                set: 'schedule_e', line: 'I-15' },
  { id: 'cat_se_taxes',          slug: 'se_taxes',          name: 'Taxes',                   set: 'schedule_e', line: 'I-16' },
  { id: 'cat_se_utilities',      slug: 'se_utilities',      name: 'Utilities',               set: 'schedule_e', line: 'I-17' },
  { id: 'cat_se_depreciation',   slug: 'se_depreciation',   name: 'Depreciation',            set: 'schedule_e', line: 'I-18' },
  { id: 'cat_se_other',          slug: 'se_other',          name: 'Other expenses',          set: 'schedule_e', line: 'I-19' },
  // Custom tracking-only categories (deducted via depreciation at tax time; no IRS line).
  { id: 'cat_se_furnishings',    slug: 'se_furnishings',    name: 'Furnishings',             set: 'schedule_e', line: ''     },
  { id: 'cat_se_capimprovements',slug: 'se_capimprovements',name: 'Capital improvements',    set: 'schedule_e', line: ''     },
] as const;

const NEW_BUDGET_CATS = [
  { id: 'cat_b_groceries',     slug: 'b_groceries',     name: 'Groceries' },
  { id: 'cat_b_dining',        slug: 'b_dining',        name: 'Dining out' },
  { id: 'cat_b_housing',       slug: 'b_housing',       name: 'Housing' },
  { id: 'cat_b_utilities',     slug: 'b_utilities',     name: 'Utilities' },
  { id: 'cat_b_transport',     slug: 'b_transport',     name: 'Transportation' },
  { id: 'cat_b_health',        slug: 'b_health',        name: 'Health and medical' },
  { id: 'cat_b_kids',          slug: 'b_kids',          name: 'Kids' },
  { id: 'cat_b_pets',          slug: 'b_pets',          name: 'Pets' },
  { id: 'cat_b_clothing',      slug: 'b_clothing',      name: 'Clothing' },
  { id: 'cat_b_personal_care', slug: 'b_personal_care', name: 'Personal care' },
  { id: 'cat_b_entertainment', slug: 'b_entertainment', name: 'Entertainment' },
  { id: 'cat_b_travel',        slug: 'b_travel',        name: 'Travel and vacations' },
  { id: 'cat_b_gifts',         slug: 'b_gifts',         name: 'Gifts and donations' },
  { id: 'cat_b_savings',       slug: 'b_savings',       name: 'Savings and investments' },
  { id: 'cat_b_misc',          slug: 'b_misc',          name: 'Miscellaneous' },
  { id: 'cat_b_insurance',     slug: 'b_insurance',     name: 'Insurance (personal)' },
  { id: 'cat_b_repairs',       slug: 'b_repairs',       name: 'Home repairs' },
  { id: 'cat_b_capgains',      slug: 'b_capgains',      name: 'Capital gains' },
] as const;

const TRANSFER_CAT_ID = 'cat_transfer';

// ─── Old D1 row shapes ───────────────────────────────────────────────────

interface OldAccountRow {
  id: string;
  teller_account_id: string | null;
}

interface OldTaxCatRow {
  slug: string;
  name: string;
  form_line: string | null;
  category_group: 'schedule_c' | 'schedule_e';
}

interface OldBudgetCatRow {
  slug: string;
  name: string;
  parent_slug: string | null;
}

interface OldTxJoinRow {
  id: string;
  account_id: string | null;
  teller_transaction_id: string | null;
  posted_date: string;
  amount: number;
  merchant_name: string | null;
  description: string;
  description_clean: string | null;
  is_pending: number;
  dedup_hash: string | null;
  note: string | null;
  created_at: string;
  // joined from classifications:
  entity: string | null;
  category_tax: string | null;
  category_budget: string | null;
  confidence: number | null;
  method: string | null;
  is_locked: number | null;
  classified_by: string | null;
  classified_at: string | null;
}

interface OldRuleRow {
  id: string;
  name: string;
  match_field: 'merchant_name' | 'description' | 'account_id' | 'amount';
  match_operator: 'contains' | 'equals' | 'starts_with' | 'ends_with' | 'regex';
  match_value: string;
  entity: string;
  category_tax: string | null;
  category_budget: string | null;
  is_active: number;
  created_at: string;
}

interface OldSplitRow {
  id: string;
  transaction_id: string;
  entity: string;
  category_tax: string | null;
  amount: number;
  note: string | null;
}

interface OldReviewQueueRow {
  transaction_id: string;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

interface Args {
  mode: 'template' | 'migrate';
  accounts: string;
  taxCats: string;
  budgetCats: string;
  transactions?: string;
  rules?: string;
  splits?: string;
  reviewQueue?: string;
  categoryMap?: string;
  out: string;
}

function parseCli(): Args {
  const { values } = parseArgs({
    options: {
      mode:          { type: 'string' },
      accounts:      { type: 'string' },
      'tax-cats':    { type: 'string' },
      'budget-cats': { type: 'string' },
      transactions:  { type: 'string' },
      rules:         { type: 'string' },
      splits:        { type: 'string' },
      'review-queue':{ type: 'string' },
      'category-map':{ type: 'string' },
      out:           { type: 'string' },
    },
  });
  const mode = values.mode as 'template' | 'migrate';
  if (mode !== 'template' && mode !== 'migrate') {
    fail(`--mode must be "template" or "migrate"`);
  }
  if (!values.accounts || !values['tax-cats'] || !values['budget-cats'] || !values.out) {
    fail(`required: --accounts --tax-cats --budget-cats --out`);
  }
  if (mode === 'migrate' && (!values.transactions || !values.rules || !values.splits || !values['review-queue'] || !values['category-map'])) {
    fail(`--mode migrate also requires: --transactions --rules --splits --review-queue --category-map`);
  }
  return {
    mode,
    accounts:     values.accounts as string,
    taxCats:      values['tax-cats'] as string,
    budgetCats:   values['budget-cats'] as string,
    transactions: values.transactions,
    rules:        values.rules,
    splits:       values.splits,
    reviewQueue:  values['review-queue'],
    categoryMap:  values['category-map'],
    out:          values.out as string,
  };
}

function fail(msg: string): never { console.error(`error: ${msg}`); process.exit(1); }

// ─── JSON loader (matches teller migration script) ───────────────────────

function loadRows<T>(path: string): T[] {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const rows = findRows<T>(raw);
  if (rows === null) throw new Error(`Unexpected JSON shape in ${path}`);
  return rows;
}

function findRows<T>(value: unknown): T[] | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return [] as T[];
    if (isEnvelope(value[0])) return findRows<T>(value[0]);
    return value as T[];
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['results', 'result', 'rows']) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return null;
}

function isEnvelope(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return 'results' in o || 'result' in o || 'rows' in o || 'success' in o || 'meta' in o;
}

// ─── Postgres value helpers ──────────────────────────────────────────────

function pgText(v: string | null | undefined): string {
  if (v == null) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function pgNum(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return 'NULL';
  return String(v);
}
function pgBool(v: number | boolean | null | undefined): string {
  if (v === true || v === 1) return 'true';
  if (v === false || v === 0) return 'false';
  return 'NULL';
}
function pgTs(v: string | null | undefined): string {
  return v ? pgText(v) : 'NULL';
}
function pgJsonb(o: unknown): string {
  return `${pgText(JSON.stringify(o))}::jsonb`;
}

// ─── Form-line normalization for tax category auto-map ───────────────────

/** Returns "II-8", "I-3a", etc. from inputs like "Part II Line 8", "Line 8", "8", "8a". */
function normalizeFormLine(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  let part = '';
  const romanMatch = s.match(/part\s+(i{1,3}|iv|v)\b/);
  if (romanMatch) part = romanMatch[1].toUpperCase();
  const lineMatch = s.match(/(?:line\s*)?(\d{1,2}[a-z]?)/);
  if (!lineMatch) return null;
  return part ? `${part}-${lineMatch[1]}` : lineMatch[1];
}

// ─── Template mode ───────────────────────────────────────────────────────

interface CategoryMapFile {
  tax:    Record<string, { old_name: string; old_form_line: string | null; old_category_group: string; new_slug: string }>;
  budget: Record<string, { old_name: string; old_parent_slug: string | null; new_slug: string }>;
}

function buildTaxMap(oldCats: OldTaxCatRow[]): CategoryMapFile['tax'] {
  const out: CategoryMapFile['tax'] = {};
  // Build line → new for each set
  const newByLine = new Map<string, string>();
  for (const c of NEW_TAX_CATS) {
    if (c.line) newByLine.set(`${c.set}|${c.line}`, c.slug);
  }
  // Also a name lookup for fallback
  const newByNameSet = new Map<string, string>();
  for (const c of NEW_TAX_CATS) newByNameSet.set(`${c.set}|${normalizeName(c.name)}`, c.slug);

  for (const r of oldCats) {
    let newSlug = '';
    const norm = normalizeFormLine(r.form_line);
    if (norm) {
      // First exact line+set match
      newSlug = newByLine.get(`${r.category_group}|${norm}`) ?? '';
      // If line had part stripped, try without
      if (!newSlug && !norm.includes('-')) {
        for (const c of NEW_TAX_CATS) {
          if (c.set === r.category_group && c.line.endsWith(`-${norm}`)) { newSlug = c.slug; break; }
        }
      }
    }
    if (!newSlug) {
      newSlug = newByNameSet.get(`${r.category_group}|${normalizeName(r.name)}`) ?? '';
    }
    out[r.slug] = {
      old_name: r.name,
      old_form_line: r.form_line,
      old_category_group: r.category_group,
      new_slug: newSlug,
    };
  }
  return out;
}

function buildBudgetMap(oldCats: OldBudgetCatRow[]): CategoryMapFile['budget'] {
  const out: CategoryMapFile['budget'] = {};
  const byNorm = new Map<string, string>();
  for (const c of NEW_BUDGET_CATS) byNorm.set(normalizeName(c.name), c.slug);
  // also map a few common synonyms
  byNorm.set(normalizeName('food'), 'b_groceries');
  byNorm.set(normalizeName('restaurants'), 'b_dining');
  byNorm.set(normalizeName('transit'), 'b_transport');
  byNorm.set(normalizeName('medical'), 'b_health');
  byNorm.set(normalizeName('rent'), 'b_housing');
  byNorm.set(normalizeName('mortgage'), 'b_housing');
  byNorm.set(normalizeName('childcare'), 'b_kids');
  byNorm.set(normalizeName('subscriptions'), 'b_entertainment');
  byNorm.set(normalizeName('charity'), 'b_gifts');
  byNorm.set(normalizeName('donations'), 'b_gifts');
  byNorm.set(normalizeName('insurance'), 'b_insurance');
  byNorm.set(normalizeName('repairs'), 'b_repairs');
  byNorm.set(normalizeName('home repairs'), 'b_repairs');
  byNorm.set(normalizeName('capital gains'), 'b_capgains');
  byNorm.set(normalizeName('capgains'), 'b_capgains');

  for (const r of oldCats) {
    const guess = byNorm.get(normalizeName(r.name))
               ?? byNorm.get(normalizeName(r.slug))
               ?? '';
    out[r.slug] = {
      old_name: r.name,
      old_parent_slug: r.parent_slug,
      new_slug: guess,
    };
  }
  return out;
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function modeTemplate(args: Args): void {
  const taxCats = loadRows<OldTaxCatRow>(args.taxCats);
  const budgetCats = loadRows<OldBudgetCatRow>(args.budgetCats);
  const map: CategoryMapFile = {
    tax: buildTaxMap(taxCats),
    budget: buildBudgetMap(budgetCats),
  };
  const unmappedTax = Object.values(map.tax).filter(v => !v.new_slug).length;
  const unmappedBudget = Object.values(map.budget).filter(v => !v.new_slug).length;
  writeFileSync(args.out, JSON.stringify(map, null, 2) + '\n', 'utf8');
  console.error(`Wrote ${args.out}`);
  console.error(`  tax categories: ${taxCats.length} (auto-mapped ${taxCats.length - unmappedTax}, ${unmappedTax} need attention)`);
  console.error(`  budget categories: ${budgetCats.length} (auto-mapped ${budgetCats.length - unmappedBudget}, ${unmappedBudget} need attention)`);
  console.error(`\nEdit ${args.out}: fill in any blank "new_slug" fields. Then re-run with --mode migrate.`);
  console.error(`\nValid new slugs:`);
  console.error(`  TAX:    ${NEW_TAX_CATS.map(c => c.slug).join(', ')}`);
  console.error(`  BUDGET: ${NEW_BUDGET_CATS.map(c => c.slug).join(', ')}`);
  console.error(`  SPECIAL: transfer`);
}

// ─── Migrate mode ────────────────────────────────────────────────────────

function loadCategoryMap(path: string): { tax: Map<string, string>; budget: Map<string, string> } {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as CategoryMapFile;
  const tax = new Map<string, string>();
  const budget = new Map<string, string>();
  for (const [oldSlug, entry] of Object.entries(raw.tax ?? {})) {
    if (entry.new_slug) tax.set(oldSlug, entry.new_slug);
  }
  for (const [oldSlug, entry] of Object.entries(raw.budget ?? {})) {
    if (entry.new_slug) budget.set(oldSlug, entry.new_slug);
  }
  return { tax, budget };
}

function slugToCategoryId(slug: string): string | null {
  if (slug === 'transfer') return TRANSFER_CAT_ID;
  for (const c of NEW_TAX_CATS) if (c.slug === slug) return c.id;
  for (const c of NEW_BUDGET_CATS) if (c.slug === slug) return c.id;
  return null;
}

interface MigrationStats {
  rawInserts: number;
  txnInserts: number;
  ruleInserts: number;
  splitInserts: number;
  skippedNoAccount: number;
  skippedNoTellerTxId: number;
  unmappedTaxSlugs: Set<string>;
  unmappedBudgetSlugs: Set<string>;
  unsupportedRules: string[];
}

function modeMigrate(args: Args): void {
  const accounts = loadRows<OldAccountRow>(args.accounts);
  const txns = loadRows<OldTxJoinRow>(args.transactions!);
  const rules = loadRows<OldRuleRow>(args.rules!);
  const splits = loadRows<OldSplitRow>(args.splits!);
  const queue = loadRows<OldReviewQueueRow>(args.reviewQueue!);
  const { tax: taxMap, budget: budgetMap } = loadCategoryMap(args.categoryMap!);

  // Old account_id → new gather_accounts.id (acct_<teller_account_id>)
  const accountIdMap = new Map<string, string>();
  for (const a of accounts) {
    if (a.teller_account_id) accountIdMap.set(a.id, `acct_${a.teller_account_id}`);
  }

  const pendingReview = new Set(queue.map(r => r.transaction_id));
  const txnIds = new Set<string>(); // for filtering splits

  const stats: MigrationStats = {
    rawInserts: 0, txnInserts: 0, ruleInserts: 0, splitInserts: 0,
    skippedNoAccount: 0, skippedNoTellerTxId: 0,
    unmappedTaxSlugs: new Set(), unmappedBudgetSlugs: new Set(),
    unsupportedRules: [],
  };

  const rawValues: string[] = [];
  const txnValues: string[] = [];

  for (const t of txns) {
    const newAccountId = t.account_id ? accountIdMap.get(t.account_id) : null;
    if (!newAccountId) { stats.skippedNoAccount++; continue; }

    const classified = !!t.entity;
    const entityId = classified ? OWNER_TAG_TO_ENTITY_ID[t.entity!] ?? null : null;

    let categoryId: string | null = null;
    let isTransfer = false;
    if (classified) {
      const taxSlug = t.category_tax ? taxMap.get(t.category_tax) : null;
      const budgetSlug = t.category_budget ? budgetMap.get(t.category_budget) : null;
      const chosen = taxSlug ?? budgetSlug ?? null;
      if (chosen) {
        categoryId = slugToCategoryId(chosen);
        if (chosen === 'transfer') isTransfer = true;
      } else {
        if (t.category_tax) stats.unmappedTaxSlugs.add(t.category_tax);
        if (t.category_budget && !t.category_tax) stats.unmappedBudgetSlugs.add(t.category_budget);
      }
    }

    const merchant = t.merchant_name ?? null;
    const description = t.description ?? t.description_clean ?? '';
    const rawId = `raw_${t.id}`;
    txnIds.add(t.id);

    if (classified) {
      // Approved or pending_review based on is_locked + review_queue
      const status = (t.is_locked === 1 && !pendingReview.has(t.id)) ? 'approved' : 'pending_review';
      // raw_transactions: status='processed', external_id=teller_transaction_id (so future Teller sync dedupes)
      if (!t.teller_transaction_id) {
        // Without teller_transaction_id, future Teller syncs can't dedupe. Still migrate but warn.
        stats.skippedNoTellerTxId++;
      }
      rawValues.push(`(${[
        pgText(rawId),
        pgText(newAccountId),
        `'teller'`,
        pgText(t.teller_transaction_id),
        pgText(t.posted_date),
        pgNum(t.amount),
        pgText(description),
        pgText(merchant),
        pgText(t.dedup_hash),
        `'processed'`,
        pgTs(t.created_at),
      ].join(', ')})`);
      stats.rawInserts++;

      txnValues.push(`(${[
        pgText(t.id),
        pgText(rawId),
        pgText(newAccountId),
        pgText(t.posted_date),
        pgNum(t.amount),
        pgText(description),
        pgText(merchant),
        entityId ? pgText(entityId) : 'NULL',
        categoryId ? pgText(categoryId) : 'NULL',
        t.method ? pgText(t.method) : 'NULL',
        pgNum(t.confidence),
        pgText(t.note),
        pgBool(isTransfer),
        pgBool(t.is_locked),
        pgText(status),
        pgText(t.teller_transaction_id),
        status === 'approved' ? pgTs(t.classified_at) : 'NULL',
        status === 'approved' ? pgText(t.classified_by) : 'NULL',
        pgTs(t.created_at),
      ].join(', ')})`);
      stats.txnInserts++;
    } else {
      // Unclassified → raw_transactions only, status='staged'
      rawValues.push(`(${[
        pgText(rawId),
        pgText(newAccountId),
        `'teller'`,
        pgText(t.teller_transaction_id),
        pgText(t.posted_date),
        pgNum(t.amount),
        pgText(description),
        pgText(merchant),
        pgText(t.dedup_hash),
        `'staged'`,
        pgTs(t.created_at),
      ].join(', ')})`);
      stats.rawInserts++;
    }
  }

  // Rules
  const ruleValues: string[] = [];
  for (const r of rules) {
    if (!r.is_active) continue;
    const matchJson = buildMatchJson(r, accountIdMap, stats);
    if (!matchJson) continue;
    const entityId = OWNER_TAG_TO_ENTITY_ID[r.entity];
    let categoryId: string | null = null;
    if (r.category_tax) {
      const newSlug = taxMap.get(r.category_tax);
      if (newSlug) categoryId = slugToCategoryId(newSlug);
      else stats.unmappedTaxSlugs.add(r.category_tax);
    }
    if (!categoryId && r.category_budget) {
      const newSlug = budgetMap.get(r.category_budget);
      if (newSlug) categoryId = slugToCategoryId(newSlug);
      else stats.unmappedBudgetSlugs.add(r.category_budget);
    }
    ruleValues.push(`(${[
      pgText(r.id),
      pgText(r.name),
      pgJsonb(matchJson),
      entityId ? pgText(entityId) : 'NULL',
      categoryId ? pgText(categoryId) : 'NULL',
      `'user'`,
      'true',
      pgTs(r.created_at),
    ].join(', ')})`);
    stats.ruleInserts++;
  }

  // Splits (only for migrated transaction_ids)
  const splitValues: string[] = [];
  for (const s of splits) {
    if (!txnIds.has(s.transaction_id)) continue;
    const entityId = OWNER_TAG_TO_ENTITY_ID[s.entity];
    let categoryId: string | null = null;
    if (s.category_tax) {
      const newSlug = taxMap.get(s.category_tax);
      if (newSlug) categoryId = slugToCategoryId(newSlug);
      else stats.unmappedTaxSlugs.add(s.category_tax);
    }
    splitValues.push(`(${[
      pgText(s.id),
      pgText(s.transaction_id),
      pgNum(s.amount),
      entityId ? pgText(entityId) : 'NULL',
      categoryId ? pgText(categoryId) : 'NULL',
      pgText(s.note),
    ].join(', ')})`);
    stats.splitInserts++;
  }

  const sql = renderSql({ rawValues, txnValues, ruleValues, splitValues, stats });
  writeFileSync(args.out, sql, 'utf8');

  console.error(`Wrote ${args.out}`);
  console.error(`  raw_transactions:   ${stats.rawInserts}`);
  console.error(`  transactions:       ${stats.txnInserts}`);
  console.error(`  rules:              ${stats.ruleInserts}  (${stats.unsupportedRules.length} unsupported, skipped)`);
  console.error(`  transaction_splits: ${stats.splitInserts}`);
  console.error(`  skipped (no account match):  ${stats.skippedNoAccount}`);
  console.error(`  classified w/o teller_tx_id: ${stats.skippedNoTellerTxId}  (still migrated, but no dedup vs future Teller sync)`);
  if (stats.unmappedTaxSlugs.size) {
    console.error(`  UNMAPPED tax slugs (left category_id=NULL):    ${[...stats.unmappedTaxSlugs].join(', ')}`);
  }
  if (stats.unmappedBudgetSlugs.size) {
    console.error(`  UNMAPPED budget slugs (left category_id=NULL): ${[...stats.unmappedBudgetSlugs].join(', ')}`);
  }
  if (stats.unsupportedRules.length) {
    console.error(`  UNSUPPORTED rules (skipped, need manual rewrite):`);
    for (const r of stats.unsupportedRules) console.error(`    - ${r}`);
  }
}

function buildMatchJson(
  r: OldRuleRow,
  accountIdMap: Map<string, string>,
  stats: MigrationStats,
): Record<string, unknown> | null {
  // New engine supports: description_contains, description_starts_with,
  // merchant_equals, amount_min, amount_max, account_id (equality).
  if (r.match_field === 'merchant_name' && r.match_operator === 'equals') {
    return { merchant_equals: r.match_value };
  }
  if (r.match_field === 'merchant_name' && r.match_operator === 'contains') {
    // Engine has no merchant_contains; description usually contains the merchant name.
    return { description_contains: r.match_value };
  }
  if (r.match_field === 'description' && r.match_operator === 'contains') {
    return { description_contains: r.match_value };
  }
  if (r.match_field === 'description' && r.match_operator === 'starts_with') {
    return { description_starts_with: r.match_value };
  }
  if (r.match_field === 'description' && r.match_operator === 'equals') {
    // Approximate as contains.
    return { description_contains: r.match_value };
  }
  if (r.match_field === 'account_id' && r.match_operator === 'equals') {
    const newId = accountIdMap.get(r.match_value);
    if (!newId) { stats.unsupportedRules.push(`${r.name}: account_id ${r.match_value} not migrated`); return null; }
    return { account_id: newId };
  }
  if (r.match_field === 'amount' && r.match_operator === 'equals') {
    const n = Number(r.match_value);
    if (Number.isFinite(n)) return { amount_min: n, amount_max: n };
  }
  stats.unsupportedRules.push(`${r.name}: ${r.match_field} ${r.match_operator}`);
  return null;
}

function renderSql({ rawValues, txnValues, ruleValues, splitValues, stats }: {
  rawValues: string[]; txnValues: string[]; ruleValues: string[]; splitValues: string[]; stats: MigrationStats;
}): string {
  const out: string[] = [];
  out.push('-- =========================================================================');
  out.push('-- CFO data migration from legacy D1 → new Neon Postgres.');
  out.push(`-- Generated ${new Date().toISOString()}.`);
  out.push('-- Review carefully before running. Wrapped in a single transaction.');
  out.push('-- =========================================================================');
  out.push('');
  out.push(`-- raw_transactions:   ${stats.rawInserts}`);
  out.push(`-- transactions:       ${stats.txnInserts}`);
  out.push(`-- rules:              ${stats.ruleInserts}`);
  out.push(`-- transaction_splits: ${stats.splitInserts}`);
  if (stats.unmappedTaxSlugs.size) out.push(`-- WARN: unmapped tax slugs: ${[...stats.unmappedTaxSlugs].join(', ')}`);
  if (stats.unmappedBudgetSlugs.size) out.push(`-- WARN: unmapped budget slugs: ${[...stats.unmappedBudgetSlugs].join(', ')}`);
  if (stats.unsupportedRules.length) {
    out.push(`-- WARN: ${stats.unsupportedRules.length} unsupported rule(s) skipped:`);
    for (const r of stats.unsupportedRules) out.push(`--   - ${r}`);
  }
  out.push('');
  out.push('BEGIN;');
  out.push('');

  if (rawValues.length) {
    out.push('-- ── raw_transactions ─────────────────────────────────────────');
    out.push('INSERT INTO raw_transactions');
    out.push('  (id, account_id, source, external_id, date, amount, description, merchant, dedup_hash, status, ingest_at)');
    out.push('VALUES');
    out.push(rawValues.join(',\n'));
    out.push('ON CONFLICT (source, external_id) DO NOTHING;');
    out.push('');
  }

  if (txnValues.length) {
    out.push('-- ── transactions ─────────────────────────────────────────────');
    out.push('INSERT INTO transactions');
    out.push('  (id, raw_id, account_id, date, amount, description, merchant,');
    out.push('   entity_id, category_id, classification_method, ai_confidence, human_notes,');
    out.push('   is_transfer, is_locked, status, teller_transaction_id, approved_at, approved_by, created_at)');
    out.push('VALUES');
    out.push(txnValues.join(',\n'));
    out.push('ON CONFLICT (id) DO NOTHING;');
    out.push('');
  }

  if (ruleValues.length) {
    out.push('-- ── rules ────────────────────────────────────────────────────');
    out.push('INSERT INTO rules');
    out.push('  (id, name, match_json, entity_id, category_id, created_by, is_active, created_at)');
    out.push('VALUES');
    out.push(ruleValues.join(',\n'));
    out.push('ON CONFLICT (id) DO NOTHING;');
    out.push('');
  }

  if (splitValues.length) {
    out.push('-- ── transaction_splits ───────────────────────────────────────');
    out.push('INSERT INTO transaction_splits');
    out.push('  (id, transaction_id, amount, entity_id, category_id, notes)');
    out.push('VALUES');
    out.push(splitValues.join(',\n'));
    out.push('ON CONFLICT (id) DO NOTHING;');
    out.push('');
  }

  out.push('COMMIT;');
  out.push('');
  out.push('-- Verify after running:');
  out.push(`--   SELECT COUNT(*) FROM raw_transactions;     -- expect at least ${stats.rawInserts}`);
  out.push(`--   SELECT COUNT(*) FROM transactions;         -- expect at least ${stats.txnInserts}`);
  out.push(`--   SELECT COUNT(*) FROM rules;                -- expect at least ${stats.ruleInserts}`);
  out.push(`--   SELECT COUNT(*) FROM transaction_splits;   -- expect at least ${stats.splitInserts}`);
  out.push('');
  return out.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseCli();
  if (args.mode === 'template') {
    modeTemplate(args);
  } else {
    if (!existsSync(args.categoryMap!)) {
      fail(`category map file not found: ${args.categoryMap}. Run --mode template first.`);
    }
    modeMigrate(args);
  }
}

main();
