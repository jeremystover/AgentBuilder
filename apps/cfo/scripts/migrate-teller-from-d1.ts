#!/usr/bin/env tsx
/**
 * One-shot migration: convert the legacy CFO D1 dump for Teller
 * enrollments + accounts into Neon-ready INSERT statements.
 *
 * Run from `apps/cfo`:
 *
 *   1. Export from the old D1 (see docs/migrate-teller-from-d1.md)
 *   2. tsx scripts/migrate-teller-from-d1.ts \
 *        --enrollments scripts/teller-enrollments-export.json \
 *        --accounts    scripts/teller-accounts-export.json \
 *        --out         scripts/teller-migration.sql
 *   3. Review the .sql file
 *   4. psql "<neon-connection-string>" -f scripts/teller-migration.sql
 *
 * NEVER commit the input JSONs or output .sql — they contain plaintext
 * Teller access tokens. Both are .gitignored at scripts/teller-*.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

interface CliArgs {
  enrollments: string;
  accounts: string;
  out: string;
}

interface OldEnrollmentRow {
  id: string;
  enrollment_id: string;
  access_token: string;
  institution_id: string | null;
  institution_name: string | null;
  last_synced_at: string | null;
  created_at: string | null;
}

interface OldAccountRow {
  id: string;
  name: string;
  institution: string | null;
  type: string;
  subtype: string | null;
  teller_account_id: string | null;
  teller_enrollment_id: string | null;
  owner_tag: string | null;
  is_active: number | boolean;
}

const OWNER_TAG_TO_ENTITY_ID: Record<string, string> = {
  elyse_coaching:  'ent_elyse_coaching',
  jeremy_coaching: 'ent_jeremy_coaching',
  airbnb_activity: 'ent_whitford',
  family_personal: 'ent_personal',
};

const VALID_NEW_TYPES = new Set(['checking', 'savings', 'credit', 'investment', 'loan', 'other']);

function parseArgsOrExit(): CliArgs {
  const { values } = parseArgs({
    options: {
      enrollments: { type: 'string' },
      accounts:    { type: 'string' },
      out:         { type: 'string' },
    },
  });
  if (!values.enrollments || !values.accounts || !values.out) {
    console.error('Usage: tsx scripts/migrate-teller-from-d1.ts --enrollments <file> --accounts <file> --out <file>');
    process.exit(1);
  }
  return values as CliArgs;
}

function loadWranglerRows<T>(path: string): T[] {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const errorMessage = extractWranglerError(raw);
  if (errorMessage) {
    throw new Error(
      `Wrangler returned an error response in ${path} instead of rows:\n  ${errorMessage}\n` +
      `Re-run the export and verify the database name + table name in the SELECT.`,
    );
  }
  const rows = findRows<T>(raw);
  if (rows !== null) return rows;
  throw new Error(`Unexpected JSON shape in ${path}. Top-level: ${describeShape(raw)}`);
}

/**
 * Wrangler reports failures by writing `{ error: "..." }` (or
 * `{ errors: [...] }`) to the output instead of rows. Surface the message
 * so the caller doesn't have to inspect the file by hand.
 */
function extractWranglerError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.error === 'string') return obj.error;
  if (obj.error && typeof obj.error === 'object') {
    const e = obj.error as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
    return JSON.stringify(obj.error);
  }
  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    return obj.errors.map(e => {
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
        return (e as { message: string }).message;
      }
      return JSON.stringify(e);
    }).join('; ');
  }
  return null;
}

/**
 * Walk the parsed JSON looking for the rows array. Wrangler's `--json`
 * output format has varied across versions and command flags; this handles
 * every shape we've actually seen in the wild:
 *
 *   [...rows]
 *   { results: [...rows] }
 *   { result:  [...rows] }
 *   { rows:    [...rows] }
 *   { success: true, results|result|rows: [...rows] }
 *   [{ ...envelope }]                       (single-statement, wrapped)
 *   [{ ...envelope }, { ...envelope }, ...] (multi-statement; first wins)
 */
function findRows<T>(value: unknown): T[] | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return [] as T[];
    if (looksLikeEnvelope(value[0])) return findRows<T>(value[0]);
    return value as T[];
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['results', 'result', 'rows'] as const) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return null;
}

function looksLikeEnvelope(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return 'results' in obj || 'result' in obj || 'rows' in obj || 'success' in obj || 'meta' in obj;
}

function describeShape(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array (empty)';
    return `array of ${typeof value[0]}` + (value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])
      ? ` with keys [${Object.keys(value[0] as object).join(', ')}]`
      : '');
  }
  if (value && typeof value === 'object') return `object with keys [${Object.keys(value).join(', ')}]`;
  return typeof value;
}

function pgText(value: string | null | undefined): string {
  if (value == null) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function pgBool(value: number | boolean | null | undefined): string {
  if (value === true || value === 1) return 'true';
  if (value === false || value === 0) return 'false';
  return 'NULL';
}

function pgTimestamp(value: string | null | undefined): string {
  if (!value) return 'NULL';
  return pgText(value);
}

function mapAccountType(rawType: string, rawSubtype: string | null): string {
  const t = (rawType ?? '').toLowerCase();
  const s = (rawSubtype ?? '').toLowerCase();
  if (t === 'credit' || s === 'credit_card') return 'credit';
  if (t === 'depository' && s === 'savings') return 'savings';
  if (t === 'depository' && s === 'checking') return 'checking';
  if (t === 'depository') return 'checking'; // best guess if subtype missing
  if (t === 'investment') return 'investment';
  if (t === 'loan') return 'loan';
  if (VALID_NEW_TYPES.has(t)) return t;
  return 'other';
}

function mapEntityId(ownerTag: string | null): string | null {
  if (!ownerTag) return null;
  return OWNER_TAG_TO_ENTITY_ID[ownerTag] ?? null;
}

function buildEnrollmentsSql(rows: OldEnrollmentRow[]): string {
  if (rows.length === 0) return '-- no teller_enrollments to import\n';
  const valueLines = rows.map(r => {
    return `  (${[
      pgText(r.id),
      pgText(r.enrollment_id),
      pgText(r.access_token),
      pgText(r.institution_id),
      pgText(r.institution_name),
      pgTimestamp(r.last_synced_at),
      pgTimestamp(r.created_at),
    ].join(', ')})`;
  });
  return [
    '-- ============================================================',
    `-- teller_enrollments  (${rows.length} row${rows.length !== 1 ? 's' : ''})`,
    '-- ============================================================',
    'INSERT INTO teller_enrollments',
    '  (id, enrollment_id, access_token, institution_id, institution_name, last_synced_at, created_at)',
    'VALUES',
    valueLines.join(',\n'),
    'ON CONFLICT (enrollment_id) DO UPDATE SET',
    '  access_token     = EXCLUDED.access_token,',
    '  institution_id   = EXCLUDED.institution_id,',
    '  institution_name = EXCLUDED.institution_name,',
    '  last_synced_at   = EXCLUDED.last_synced_at;',
    '',
  ].join('\n');
}

interface MappedAccount {
  newId: string;
  name: string;
  institution: string | null;
  type: string;
  entityId: string | null;
  isActive: number | boolean;
  tellerAccountId: string | null;
  tellerEnrollmentId: string | null;
  skipped?: string;
  ownerTagOriginal?: string | null;
}

function mapAccounts(rows: OldAccountRow[]): MappedAccount[] {
  return rows.map(r => {
    const mapped: MappedAccount = {
      newId: r.teller_account_id ? `acct_${r.teller_account_id}` : r.id,
      name: r.name,
      institution: r.institution,
      type: mapAccountType(r.type, r.subtype),
      entityId: mapEntityId(r.owner_tag),
      isActive: r.is_active,
      tellerAccountId: r.teller_account_id,
      tellerEnrollmentId: r.teller_enrollment_id,
      ownerTagOriginal: r.owner_tag,
    };
    if (!r.teller_account_id) mapped.skipped = 'no teller_account_id';
    return mapped;
  });
}

function buildAccountsSql(mapped: MappedAccount[]): string {
  const kept = mapped.filter(a => !a.skipped);
  if (kept.length === 0) return '-- no gather_accounts to import\n';
  const valueLines = kept.map(a => {
    return `  (${[
      pgText(a.newId),
      pgText(a.name),
      pgText(a.institution),
      pgText(a.type),
      "'teller'",
      a.entityId ? pgText(a.entityId) : 'NULL',
      pgBool(a.isActive),
      pgText(a.tellerAccountId),
      pgText(a.tellerEnrollmentId),
    ].join(', ')})`;
  });
  return [
    '-- ============================================================',
    `-- gather_accounts  (${kept.length} row${kept.length !== 1 ? 's' : ''})`,
    '-- ============================================================',
    'INSERT INTO gather_accounts',
    '  (id, name, institution, type, source, entity_id, is_active, teller_account_id, teller_enrollment_id)',
    'VALUES',
    valueLines.join(',\n'),
    'ON CONFLICT (teller_account_id) DO UPDATE SET',
    '  name                 = EXCLUDED.name,',
    '  institution          = EXCLUDED.institution,',
    '  type                 = EXCLUDED.type,',
    '  entity_id            = EXCLUDED.entity_id,',
    '  is_active            = EXCLUDED.is_active,',
    '  teller_enrollment_id = EXCLUDED.teller_enrollment_id,',
    '  updated_at           = now();',
    '',
  ].join('\n');
}

function buildReport(mapped: MappedAccount[]): string {
  const skipped = mapped.filter(a => a.skipped);
  const byOwnerTag = new Map<string, number>();
  for (const a of mapped) {
    const tag = a.ownerTagOriginal ?? '(none)';
    byOwnerTag.set(tag, (byOwnerTag.get(tag) ?? 0) + 1);
  }
  const unknownTags = [...byOwnerTag.keys()].filter(
    tag => tag !== '(none)' && !(tag in OWNER_TAG_TO_ENTITY_ID),
  );
  const lines: string[] = [
    '-- ============================================================',
    '-- Conversion report (informational; safe to ignore)',
    '-- ============================================================',
  ];
  for (const [tag, count] of byOwnerTag) {
    const mappedId = tag === '(none)' ? 'NULL' : (OWNER_TAG_TO_ENTITY_ID[tag] ?? 'UNKNOWN');
    lines.push(`--   owner_tag=${tag.padEnd(20)} -> entity_id=${mappedId}    (${count} account${count !== 1 ? 's' : ''})`);
  }
  if (unknownTags.length > 0) {
    lines.push(`--`);
    lines.push(`-- WARNING: unmapped owner_tag values found — these accounts will land with entity_id = NULL:`);
    for (const tag of unknownTags) lines.push(`--   ${tag}`);
  }
  if (skipped.length > 0) {
    lines.push(`--`);
    lines.push(`-- SKIPPED ${skipped.length} row(s) with no teller_account_id (can't reconcile via UNIQUE):`);
    for (const a of skipped) lines.push(`--   ${a.name}  (old id=${a.newId})`);
  }
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const args = parseArgsOrExit();
  const enrollments = loadWranglerRows<OldEnrollmentRow>(args.enrollments);
  const accounts = loadWranglerRows<OldAccountRow>(args.accounts);

  const mapped = mapAccounts(accounts);

  const sql = [
    '-- =========================================================================',
    '-- Teller migration from legacy CFO D1 → new Neon Postgres.',
    `-- Generated ${new Date().toISOString()}.`,
    '-- Wrapped in a single transaction; review carefully before running.',
    '-- =========================================================================',
    '',
    buildReport(mapped),
    'BEGIN;',
    '',
    buildEnrollmentsSql(enrollments),
    buildAccountsSql(mapped),
    'COMMIT;',
    '',
    '-- After running, verify:',
    `--   SELECT COUNT(*) FROM teller_enrollments;   -- expect ${enrollments.length}`,
    `--   SELECT COUNT(*) FROM gather_accounts WHERE source = 'teller';   -- expect ${mapped.filter(a => !a.skipped).length}`,
    '',
  ].join('\n');

  writeFileSync(args.out, sql, 'utf8');
  console.error(`Wrote ${args.out}`);
  console.error(`  enrollments: ${enrollments.length}`);
  console.error(`  accounts:    ${mapped.filter(a => !a.skipped).length} (skipped ${mapped.filter(a => a.skipped).length})`);
}

main();
