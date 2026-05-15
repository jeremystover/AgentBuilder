/**
 * Build a ReportOutput for a saved report config + date range. Pure
 * Postgres query + grouping; no I/O beyond the read. Google Sheets
 * output lives in google-sheets.ts and consumes this shape.
 */

import type { Env } from '../types';
import { db, pgArr, type Sql } from './db';

export interface ReportConfig {
  id: string;
  name: string;
  entity_ids: string[];
  category_ids: string[];
  category_mode: 'tax' | 'budget' | 'all';
  include_transactions: boolean;
  drive_folder_id: string | null;
  notes: string | null;
}

export interface ReportLine {
  line_number: string;
  label: string;
  total: number;
  transactions?: Array<{ date: string; description: string; amount: number; merchant: string | null }>;
}

export interface ReportSection {
  section_name: string;
  lines: ReportLine[];
  section_total: number;
}

export interface ReportOutput {
  title: string;
  date_range: { from: string; to: string };
  generated_at: string;
  entity_names: string[];
  unreviewed_warning_count: number;
  sections: ReportSection[];
  net_total: number;
}

interface TxRow {
  date: string;
  amount: number;
  description: string;
  merchant: string | null;
  entity_id: string | null;
  entity_name: string | null;
  category_id: string | null;
  category_name: string | null;
  category_slug: string | null;
  category_set: string | null;
  form_line: string | null;
}

// postgres-js with fetch_types:false returns PG array columns as "{a,b,c}" strings.
function parsePgArr(val: unknown): string[] {
  if (Array.isArray(val)) return val as string[];
  if (typeof val !== 'string') return [];
  const inner = val.replace(/^\{|\}$/g, '').trim();
  return inner ? inner.split(',') : [];
}

export async function getReportConfig(env: Env, id: string): Promise<ReportConfig | null> {
  const sql = db(env);
  try {
    const rows = await sql<Array<ReportConfig>>`
      SELECT id, name, entity_ids, category_ids, category_mode,
             include_transactions, drive_folder_id, notes
      FROM report_configs
      WHERE id = ${id} AND is_active = true
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      entity_ids: parsePgArr(row.entity_ids),
      category_ids: parsePgArr(row.category_ids),
    };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function generateReport(env: Env, config: ReportConfig, dateFrom: string, dateTo: string): Promise<ReportOutput> {
  const sql = db(env);
  try {
    // Resolve entity names (for the title block).
    const entityNames = await fetchEntityNames(sql, config.entity_ids);

    // Count unreviewed (raw_transactions in the same window for the same entities, where they have one).
    const unreviewed = await countUnreviewed(sql, config, dateFrom, dateTo);

    const txs = await fetchTransactions(sql, config, dateFrom, dateTo);
    const sections = config.category_mode === 'tax'
      ? buildTaxSections(txs, config.include_transactions)
      : buildBudgetSections(txs, config.include_transactions);

    const netTotal = sections.reduce((sum, s) => {
      if (s.section_name.toLowerCase().includes('income') || s.section_name.toLowerCase().includes('revenue')) {
        return sum + s.section_total;
      }
      if (s.section_name.toLowerCase().includes('expense')) {
        return sum - Math.abs(s.section_total);
      }
      return sum + s.section_total;
    }, 0);

    return {
      title: config.name,
      date_range: { from: dateFrom, to: dateTo },
      generated_at: new Date().toISOString(),
      entity_names: entityNames,
      unreviewed_warning_count: unreviewed,
      sections,
      net_total: netTotal,
    };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function fetchEntityNames(sql: Sql, entityIds: string[]): Promise<string[]> {
  if (entityIds.length === 0) {
    const rows = await sql<Array<{ name: string }>>`SELECT name FROM entities WHERE is_active = true ORDER BY name`;
    return rows.map(r => r.name);
  }
  const rows = await sql<Array<{ name: string }>>`SELECT name FROM entities WHERE id = ANY(${pgArr(entityIds)}::text[]) ORDER BY name`;
  return rows.map(r => r.name);
}

async function countUnreviewed(sql: Sql, config: ReportConfig, from: string, to: string): Promise<number> {
  const rows = config.entity_ids.length > 0
    ? await sql<Array<{ n: string }>>`
        SELECT COUNT(*)::text AS n FROM raw_transactions r
        LEFT JOIN gather_accounts a ON a.id = r.account_id
        WHERE r.status IN ('staged', 'waiting')
          AND r.date BETWEEN ${from} AND ${to}
          AND (r.entity_id = ANY(${pgArr(config.entity_ids)}::text[]) OR a.entity_id = ANY(${pgArr(config.entity_ids)}::text[]))
      `
    : await sql<Array<{ n: string }>>`
        SELECT COUNT(*)::text AS n FROM raw_transactions
        WHERE status IN ('staged', 'waiting')
          AND date BETWEEN ${from} AND ${to}
      `;
  return Number(rows[0]?.n ?? 0);
}

async function fetchTransactions(sql: Sql, config: ReportConfig, from: string, to: string): Promise<TxRow[]> {
  const rows = await sql<Array<{
    date: string; amount: string; description: string; merchant: string | null;
    entity_id: string | null; entity_name: string | null;
    category_id: string | null; category_name: string | null; category_slug: string | null;
    category_set: string | null; form_line: string | null;
  }>>`
    SELECT
      to_char(t.date, 'YYYY-MM-DD') AS date, t.amount::text AS amount,
      t.description, t.merchant,
      t.entity_id, en.name AS entity_name,
      t.category_id, c.name AS category_name, c.slug AS category_slug,
      c.category_set, c.form_line
    FROM transactions t
    LEFT JOIN entities en ON en.id = t.entity_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.status = 'approved'
      AND t.date BETWEEN ${from} AND ${to}
      ${config.entity_ids.length > 0 ? sql`AND t.entity_id = ANY(${pgArr(config.entity_ids)}::text[])` : sql``}
      ${config.category_mode === 'tax'    ? sql`AND c.category_set IN ('schedule_c', 'schedule_e')` : sql``}
      ${config.category_mode === 'budget' ? sql`AND c.category_set = 'budget'`                       : sql``}
      ${config.category_ids.length > 0    ? sql`AND t.category_id = ANY(${pgArr(config.category_ids)}::text[])`     : sql``}
    ORDER BY c.form_line NULLS LAST, c.name, t.date
  `;
  return rows.map(r => ({
    ...r,
    amount: Number(r.amount),
  }));
}

// ── Tax (Schedule C / E) ────────────────────────────────────────────────────

/**
 * Group transactions by category, then split into Income / Expense sections
 * by inspecting form_line. Anything in "Part I" is income; everything else
 * is expense. (Works for both Schedule C and Schedule E seed data.)
 */
function buildTaxSections(txs: TxRow[], includeTx: boolean): ReportSection[] {
  const byCategory = new Map<string, ReportLine>();
  for (const t of txs) {
    if (!t.category_id) continue;
    const key = t.category_id;
    const existing = byCategory.get(key) ?? {
      line_number: t.form_line ?? '—',
      label: t.category_name ?? '(uncategorized)',
      total: 0,
      transactions: includeTx ? [] : undefined,
    };
    existing.total += t.amount;
    if (includeTx) existing.transactions!.push({
      date: t.date, description: t.description, amount: t.amount, merchant: t.merchant,
    });
    byCategory.set(key, existing);
  }
  const all = Array.from(byCategory.values());
  all.sort((a, b) => compareFormLine(a.line_number, b.line_number));

  const income = all.filter(l => /Part I /i.test(l.line_number));
  const expense = all.filter(l => !/Part I /i.test(l.line_number));

  const sumOf = (lines: ReportLine[]) => lines.reduce((s, l) => s + l.total, 0);
  const incomeTotal = sumOf(income);
  // Card/debit signs are: spend = positive on credit accounts, negative on
  // depository. Expense category totals can land with either sign in
  // transactions. Report the absolute aggregate as expense magnitude.
  const expenseTotal = Math.abs(sumOf(expense));

  const sections: ReportSection[] = [];
  if (income.length > 0) sections.push({ section_name: 'Income (Part I)', lines: income, section_total: incomeTotal });
  if (expense.length > 0) sections.push({ section_name: 'Expenses (Part II)', lines: expense, section_total: expenseTotal });
  return sections;
}

function compareFormLine(a: string, b: string): number {
  // Sort by Part roman numeral, then numeric line.
  const re = /Part\s+(I+|II+|III+|IV+)?\s*Line\s*(\d+)/i;
  const ma = a.match(re);
  const mb = b.match(re);
  if (!ma && !mb) return a.localeCompare(b);
  if (!ma) return 1;
  if (!mb) return -1;
  const partOrder = (s: string) => ({ I: 1, II: 2, III: 3, IV: 4 } as Record<string, number>)[s.toUpperCase()] ?? 99;
  const pa = partOrder(ma[1] ?? '');
  const pb = partOrder(mb[1] ?? '');
  if (pa !== pb) return pa - pb;
  return Number(ma[2]) - Number(mb[2]);
}

// ── Budget ──────────────────────────────────────────────────────────────────

/**
 * Group by entity, then by category within each entity. Section per entity.
 */
function buildBudgetSections(txs: TxRow[], includeTx: boolean): ReportSection[] {
  const byEntity = new Map<string, Map<string, ReportLine>>();
  for (const t of txs) {
    const entityKey = t.entity_name ?? '(unassigned)';
    let group = byEntity.get(entityKey);
    if (!group) {
      group = new Map();
      byEntity.set(entityKey, group);
    }
    const catKey = t.category_id ?? '__uncat__';
    const existing = group.get(catKey) ?? {
      line_number: '—',
      label: t.category_name ?? '(uncategorized)',
      total: 0,
      transactions: includeTx ? [] : undefined,
    };
    existing.total += t.amount;
    if (includeTx) existing.transactions!.push({
      date: t.date, description: t.description, amount: t.amount, merchant: t.merchant,
    });
    group.set(catKey, existing);
  }
  return Array.from(byEntity.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([entityName, group]) => {
      const lines = Array.from(group.values()).sort((a, b) => a.label.localeCompare(b.label));
      const total = lines.reduce((s, l) => s + l.total, 0);
      return { section_name: entityName, lines, section_total: total };
    });
}
