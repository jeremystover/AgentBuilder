/**
 * Applies pending SQL migrations to the Neon Postgres database.
 *
 * Usage (local):  DATABASE_URL=<neon-url> pnpm run migrate
 * Usage (CI):     DATABASE_URL is injected via NEON_DATABASE_URL secret
 *
 * Bootstrap behaviour (first run against an existing database):
 *   If schema_migrations is empty but raw_transactions already exists, all
 *   migrations up to BOOTSTRAP_BASELINE are seeded as already-applied
 *   rather than re-executed. They were applied manually before automated
 *   tracking was introduced. Only migrations AFTER the baseline are run.
 */

import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

// Last migration filename that was applied manually before automated
// tracking was introduced. Migrations <= this value are seeded on first run.
const BOOTSTRAP_BASELINE = '0016_expense_flag.sql';

const migrationsDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'migrations');
const sql = postgres(DATABASE_URL, { max: 1 });

async function run() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const [{ count }] = await sql<[{ count: number }]>`
    SELECT COUNT(*)::int AS count FROM schema_migrations
  `;
  const [{ schema_exists }] = await sql<[{ schema_exists: boolean }]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'raw_transactions'
    ) AS schema_exists
  `;

  if (count === 0 && schema_exists) {
    console.log('First run on existing schema — seeding migration baseline...');
    const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const filename of files) {
      if (filename <= BOOTSTRAP_BASELINE) {
        await sql`
          INSERT INTO schema_migrations (filename) VALUES (${filename})
          ON CONFLICT DO NOTHING
        `;
        console.log(`  seeded  ${filename}`);
      }
    }
  }

  const allFiles = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const appliedRows = await sql<Array<{ filename: string }>>`SELECT filename FROM schema_migrations`;
  const applied = new Set(appliedRows.map(r => r.filename));

  let appliedCount = 0;
  for (const filename of allFiles) {
    if (applied.has(filename)) {
      console.log(`  ✓ already applied  ${filename}`);
      continue;
    }
    console.log(`  → applying ${filename}...`);
    const content = readFileSync(join(migrationsDir, filename), 'utf8');
    await sql.unsafe(content);
    await sql`INSERT INTO schema_migrations (filename) VALUES (${filename}) ON CONFLICT DO NOTHING`;
    console.log(`  ✓ applied           ${filename}`);
    appliedCount++;
  }

  await sql.end();
  console.log(`\nDone — ${appliedCount} migration(s) applied.`);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
