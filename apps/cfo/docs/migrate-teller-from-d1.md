# Teller migration: legacy CFO D1 → new Neon

One-shot migration that pulls existing Teller enrollments and accounts
out of the legacy CFO's D1 (`cfo-db`) and seeds them into the new
system's `teller_enrollments` + `gather_accounts` tables in Neon, so the
existing bank connections don't need to be re-enrolled.

Inputs are JSON dumps from `wrangler d1 execute`; the conversion runs
locally and produces a single `.sql` file you review and apply via psql
or the Neon SQL editor.

**The JSON dumps and the generated SQL contain plaintext Teller access
tokens.** Both are `.gitignored` under `apps/cfo/scripts/teller-*` —
keep them off shared filesystems and rotate them when you're done.

## 1. Export from the old D1

Run from `apps/cfo/`. Requires `wrangler login` against the Cloudflare
account that owns `cfo-db`.

```bash
# Enrollments — the legacy schema has no is_active column on this
# table; active-state lives on `accounts`. Pull all enrollments; any
# that no longer have active accounts will simply Teller-`reconnect_required`
# on the first /teller/sync and can be cleared from the new DB then.
wrangler d1 execute cfo-db --remote --command \
  "SELECT id, enrollment_id, access_token, institution_id, institution_name,
          last_synced_at, created_at
   FROM teller_enrollments" \
  --json > scripts/teller-enrollments-export.json

# Accounts (note: we pull subtype and owner_tag too)
wrangler d1 execute cfo-db --remote --command \
  "SELECT id, name, institution, type, subtype,
          teller_account_id, teller_enrollment_id, owner_tag, is_active
   FROM accounts
   WHERE source = 'teller'" \
  --json > scripts/teller-accounts-export.json
```

If the old CFO's accounts table column is named differently in your
schema (older migrations used `is_business` or similar instead of
`owner_tag`), adjust the SELECT accordingly — the script reads each
field by name.

## 2. Convert to SQL

```bash
pnpm exec tsx scripts/migrate-teller-from-d1.ts \
  --enrollments scripts/teller-enrollments-export.json \
  --accounts    scripts/teller-accounts-export.json \
  --out         scripts/teller-migration.sql
```

The script:

- Reads the wrangler envelope (`[0].results`)
- Maps `owner_tag` → entity_id:
  - `elyse_coaching`  → `ent_elyse_coaching`
  - `jeremy_coaching` → `ent_jeremy_coaching`
  - `airbnb_activity` → `ent_whitford`
  - `family_personal` → `ent_personal`
  - anything else / NULL → unassigned, with a warning in the SQL header
- Maps Teller account `type` + `subtype` → the new constrained type
  (`checking` | `savings` | `credit` | `investment` | `loan` | `other`).
  Note: depository + missing subtype defaults to `checking`.
- Renames each account's id to `acct_<teller_account_id>` so future
  `POST /teller/enroll` calls reconcile via the existing
  `ON CONFLICT (teller_account_id)` path.
- Skips any account row with NULL `teller_account_id` (logged at top of
  output SQL).
- Wraps everything in `BEGIN; … COMMIT;`.
- Top of the file is a comment block summarising counts + any unmapped
  owner_tag values you should know about.

## 3. Apply to Neon

```bash
# psql
psql "<NEON_CONNECTION_STRING>" -f scripts/teller-migration.sql

# or Neon SQL editor: paste the file contents and run.
```

Both `INSERT`s use `ON CONFLICT … DO UPDATE` on the natural unique key
(`enrollment_id` for enrollments, `teller_account_id` for accounts), so
re-running is safe.

Verify the counts the SQL comment block prints:

```sql
SELECT COUNT(*) FROM teller_enrollments;
SELECT COUNT(*) FROM gather_accounts WHERE source = 'teller';
```

## 4. Smoke-test the tokens

Hit `POST /teller/sync` against the deployed worker. With the migration
applied, it should:

- Find each enrollment row
- Find the gather_accounts rows linked by `teller_enrollment_id`
- For each, fetch transactions and stage them in `raw_transactions`

```bash
curl -X POST https://cfo.<account>.workers.dev/teller/sync \
  -H 'content-type: application/json' -d '{}'
```

If you see `reconnect_required` for any institution, the access_token
was rotated or revoked since the export — re-enrol that bank via the
new SPA's Gather page.

## 5. Clean up

Delete the local exports + SQL once verified:

```bash
rm scripts/teller-enrollments-export.json
rm scripts/teller-accounts-export.json
rm scripts/teller-migration.sql
```
