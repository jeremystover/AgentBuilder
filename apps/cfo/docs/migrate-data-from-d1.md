# Data migration: legacy CFO D1 → new Neon

Brings transactions (approved + in-flight), classifications, rules, and
transaction splits from the legacy CFO's D1 over to the new Neon schema.

Prerequisites:
- The Teller migration (`docs/migrate-teller-from-d1.md`) has already been
  applied — `gather_accounts` rows exist for every Teller account this
  script needs to reference.
- New schema migrations 0001–0014 are applied (seed categories present).

All inputs and outputs are gitignored under `scripts/d1-*` — they contain
personal financial data.

## Field mapping

| Old D1                                              | New Neon |
|-----------------------------------------------------|----------|
| `transactions` + `classifications` (joined)         | `transactions` (with `raw_transactions` shadow row, `status='processed'`, so future Teller syncs dedupe via `UNIQUE(source, external_id)`) |
| `transactions` with no `classifications` row        | `raw_transactions` (`status='staged'`) — shows in Review queue |
| `classifications.is_locked = 1` AND no pending `review_queue` | `transactions.status = 'approved'` |
| any other classified row                            | `transactions.status = 'pending_review'` |
| `classifications.entity`                            | `transactions.entity_id` (via `OWNER_TAG_TO_ENTITY_ID`) |
| `classifications.category_tax` / `category_budget`  | `transactions.category_id` (via `d1-category-map.json`) |
| `classifications.method`                            | `transactions.classification_method` (same enum) |
| `classifications.confidence`                        | `transactions.ai_confidence` |
| `transactions.note`                                 | `transactions.human_notes` |
| `transactions.teller_transaction_id`                | `transactions.teller_transaction_id` AND `raw_transactions.external_id` |
| `rules`                                             | `rules.match_json` (translated to engine's supported keys) |
| `transaction_splits`                                | `transaction_splits` (entity → entity_id, category_tax → category_id) |
| `review_queue`, `sms_*`, `*_email_*`                | dropped — review queue is implicit (raw_transactions status); SMS removed; email enrichment will rebuild via Gmail sync |

## 1. Export from old D1

Run from `apps/cfo/`. Requires `wrangler login` for the Cloudflare account
that owns `cfo-db`.

```bash
# Accounts — reuse the existing teller migration export. If you've already
# deleted it, re-run that export from docs/migrate-teller-from-d1.md.

# Tax categories (your old per-user slugs)
wrangler d1 execute cfo-db --remote --json --command \
  "SELECT slug, name, form_line, category_group FROM tax_categories WHERE is_active = 1" \
  > scripts/d1-tax-categories.json

# Budget categories
wrangler d1 execute cfo-db --remote --json --command \
  "SELECT slug, name, parent_slug FROM budget_categories WHERE is_active = 1" \
  > scripts/d1-budget-categories.json

# Transactions joined with classifications (LEFT JOIN — includes unclassified)
wrangler d1 execute cfo-db --remote --json --command \
  "SELECT t.id, t.account_id, t.teller_transaction_id, t.posted_date, t.amount,
          t.merchant_name, t.description, t.description_clean, t.is_pending,
          t.dedup_hash, t.note, t.created_at,
          c.entity, c.category_tax, c.category_budget, c.confidence, c.method,
          c.is_locked, c.classified_by, c.classified_at
   FROM transactions t LEFT JOIN classifications c ON c.transaction_id = t.id" \
  > scripts/d1-transactions.json

# Rules (only active)
wrangler d1 execute cfo-db --remote --json --command \
  "SELECT id, name, match_field, match_operator, match_value, entity,
          category_tax, category_budget, is_active, created_at
   FROM rules WHERE is_active = 1" \
  > scripts/d1-rules.json

# Transaction splits
wrangler d1 execute cfo-db --remote --json --command \
  "SELECT id, transaction_id, entity, category_tax, amount, note
   FROM transaction_splits" \
  > scripts/d1-transaction-splits.json

# Pending review_queue (used to mark status='pending_review' on the new side)
wrangler d1 execute cfo-db --remote --json --command \
  "SELECT transaction_id FROM review_queue WHERE status = 'pending'" \
  > scripts/d1-review-queue.json
```

## 2. Build the category-map template

```bash
pnpm exec tsx scripts/migrate-data-from-d1.ts \
  --mode template \
  --accounts    scripts/teller-accounts-export.json \
  --tax-cats    scripts/d1-tax-categories.json \
  --budget-cats scripts/d1-budget-categories.json \
  --out         scripts/d1-category-map.json
```

The script auto-maps **tax categories by IRS form line** (e.g. `Part II
Line 8` → `sc_advertising`) and **budget categories by name match**
(e.g. "Groceries" → `b_groceries`, with common synonyms like "Food",
"Restaurants", "Transit", "Medical"...).

The console output lists the unmapped count and the full set of valid new
slugs. **Open `scripts/d1-category-map.json` and fill in any blank
`"new_slug"` fields** (or change wrong guesses). Empty `new_slug` will
cause those transactions to land with `category_id = NULL` (they still
import, but you'd need to re-categorize them).

Special slug: `transfer` (for internal transfers — sets `is_transfer=true`
on the transaction).

## 3. Generate the migration SQL

```bash
pnpm exec tsx scripts/migrate-data-from-d1.ts \
  --mode migrate \
  --accounts     scripts/teller-accounts-export.json \
  --tax-cats     scripts/d1-tax-categories.json \
  --budget-cats  scripts/d1-budget-categories.json \
  --transactions scripts/d1-transactions.json \
  --rules        scripts/d1-rules.json \
  --splits       scripts/d1-transaction-splits.json \
  --review-queue scripts/d1-review-queue.json \
  --category-map scripts/d1-category-map.json \
  --out          scripts/d1-migration.sql
```

The console summary tells you what was migrated, what was skipped, and any
remaining unmapped slugs or unsupported rule patterns. Skim
`scripts/d1-migration.sql` — the header comments list every warning.

**Rule translation:** the new rules engine only supports
`description_contains`, `description_starts_with`, `merchant_equals`,
`amount_min/max`, and `account_id` equality. Old rules using
`ends_with` or `regex` are skipped (named in the warnings); you can
recreate them via the Rules page.

## 4. Apply to Neon

```bash
psql "<NEON_CONNECTION_STRING>" -f scripts/d1-migration.sql
```

The whole file is wrapped in `BEGIN; … COMMIT;` so a single failed
constraint rolls everything back.

Verify:

```sql
SELECT COUNT(*) FROM raw_transactions;
SELECT COUNT(*) FROM transactions;
SELECT COUNT(*) FROM rules;
SELECT COUNT(*) FROM transaction_splits;

-- Spot check classifications survived:
SELECT entity_id, COUNT(*) FROM transactions WHERE status='approved' GROUP BY 1;
SELECT category_id, COUNT(*) FROM transactions WHERE status='approved' GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

## 5. Continue with the rest of the migration plan

After this is applied, return to the main migration steps (transactions
are now seeded — skip `POST /teller/sync` if you don't want a fresh pull,
or run it to backfill any newer transactions; dedup via `UNIQUE(source,
external_id)` will skip overlap).

## 6. Clean up

```bash
rm scripts/d1-*.json scripts/d1-migration.sql
```
