# Email parser calibration — TODO

This document is the **ground truth** for the vendor email parsers in
`src/lib/email-parsers/`. Phase 1b's spec (`docs/build-prompts/build-phase-1b-email-parsing.md`)
requires that this file be populated with **3 real samples per vendor**
BEFORE the parsers are trusted in production.

The current parsers were scaffolded from the legacy CFO regexes (see
`apps/cfo/src/lib/{amazon,venmo,apple,etsy}-email.ts` on `main`) as a
calibration baseline. They compile and have unit-level type contracts,
but have **not** been validated against fresh samples in this rebuild.

## Status

| Vendor | Samples collected | Search query validated | Parser field map verified | Matcher threshold validated |
|--------|-------------------|------------------------|---------------------------|-----------------------------|
| Amazon | ☐ 0/3             | ☐                      | ☐                         | ☐                           |
| Venmo  | ☐ 0/3             | ☐                      | ☐                         | ☐                           |
| Apple  | ☐ 0/3             | ☐                      | ☐                         | ☐                           |
| Etsy   | ☐ 0/3             | ☐                      | ☐                         | ☐                           |

## Sampling procedure

Once the OAuth bootstrap below is complete and `wrangler tail` is
attached, run `POST /gmail/sync/<vendor>` against the deployed worker
and inspect the logs. For each vendor, capture for each of 3 samples:

- Exact `subject` line
- Exact `from` address
- Date in body vs. internalDate (Etsy especially)
- Extracted fields: amount, date, merchant/counterparty, items[], order ID, memo
- Format variations observed across samples

Then update the table above and adjust regexes / thresholds in:

- `src/lib/email-parsers/{amazon,venmo,apple,etsy}.ts`
- `src/lib/email-matchers/match.ts`

## Current search queries

Defined in `src/lib/email-sync.ts`:

| Vendor | Query |
|--------|-------|
| Amazon | `from:(auto-confirm@amazon.com OR ship-confirm@amazon.com OR shipment-tracking@amazon.com OR order-update@amazon.com) subject:"Your Amazon.com order" newer_than:90d` |
| Venmo  | `from:venmo@venmo.com newer_than:90d` |
| Apple  | `subject:"receipt from Apple" newer_than:90d` |
| Etsy   | `(from:(transaction@etsy.com OR support@etsy.com) OR subject:etsy) newer_than:90d` |

## Current matcher thresholds

Defined in `src/lib/email-matchers/match.ts`:

| Vendor | Threshold | Window     | Notes |
|--------|-----------|------------|-------|
| Amazon | 60        | -2 to +12d | Ships post after confirmation; window forward-skewed |
| Venmo  | 70        | ±2d        | Amounts always exact |
| Apple  | 65        | -2 to +5d  | Same-day receipt, card posts up to 4 days later |
| Etsy   | 60        | -2 to +5d (or -60 to +5d for forwarded emails) | Body date is the source of truth for forwarded |

## Google OAuth bootstrap (one-time)

The Gmail client reads tokens from the `cfo-tokens` D1 vault scoped by
`(agentId='cfo', userId='default')`. Before any email sync can run:

1. Create the D1 database and apply the schema:
   ```bash
   wrangler d1 create cfo-tokens
   # paste the returned database_id into apps/cfo/wrangler.toml [[d1_databases]] TOKENS
   wrangler d1 execute cfo-tokens --remote --file=apps/cfo/schema/d1/google-tokens.sql
   ```
2. Generate a fresh AES-256 KEK and set it as a worker secret:
   ```bash
   openssl rand -base64 32 | wrangler secret put GOOGLE_TOKEN_VAULT_KEK
   ```
3. Set the fleet-wide OAuth client credentials:
   ```bash
   wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   ```
4. Run the chief-of-staff Google auth flow (or a copy of it) with the
   `gmail.readonly` scope to seed the encrypted token row in
   `cfo-tokens.google_tokens` with `agent_id='cfo'`, `user_id='default'`.
   A `/auth/google/start` route inside this worker is **not yet wired up** —
   token bootstrap is a follow-up task.

## Open issues blocking validation

1. No `/auth/google/start` flow in this worker yet → token seeding must
   happen out-of-band (e.g. by reusing chief-of-staff's flow with a
   modified `agent_id`).
2. Phase 1a Hyperdrive id is still blank in `wrangler.toml`, so a deploy
   is blocked until that and the D1 IDs are set.
3. CI workflow still passes `d1_database: cfo-db` to the shared deploy —
   will fail when trying to apply Postgres SQL to D1. Flagged in Phase 1a.
