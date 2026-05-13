# Build Prompt — Phase 1b: Email Parsing

**Session goal:** Build the Gmail integration and email enrichment pipeline for the Gather module. Email enrichment adds context to staged transactions — it does NOT classify, approve, or trigger review status changes.

**Before writing any code:** Read `apps/cfo/CLAUDE.md`. Then read the existing CFO parsers as reference:
- `apps/cfo/src/lib/gmail.ts`
- `apps/cfo/src/lib/amazon-email.ts`
- `apps/cfo/src/lib/venmo-email.ts`
- `apps/cfo/src/lib/apple-email.ts`
- `apps/cfo/src/lib/etsy-email.ts`

Read them fully. Do not copy them. You are rewriting against a different architecture.

**Phase 1a must be complete before starting this session.**

---

## Architecture: How Email Fits In

```
Gmail API
    ↓
  Gmail client (auth via @agentbuilder/auth-google)
    ↓
  Email scanner (find unprocessed messages matching vendor patterns)
    ↓
  Email parser (extract structured context per vendor)
    ↓
  Transaction matcher (find matching raw_transaction by amount + date)
    ↓
  raw_transactions.supplement_json updated with vendor context
  raw_transactions.status updated: 'waiting' → 'staged' (if match found)
```

Email never writes to the `transactions` table. Email never sets approval status. Email adds `supplement_json` context to `raw_transactions` rows that already exist from Teller sync.

---

## Step 1: Gmail client via `@agentbuilder/auth-google`

Do NOT copy `apps/cfo/src/lib/gmail.ts`. Instead, use `@agentbuilder/auth-google`.

Read the `packages/auth-google/` source first to understand its API. Create `src/lib/gmail.ts` as a thin wrapper:

```typescript
import { getGoogleAccessToken } from '@agentbuilder/auth-google';
import type { Env } from '../types';

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  body: string;        // decoded text/plain or text/html
  bodyHtml?: string;
}

// Search for messages matching a query
export async function searchMessages(
  env: Env,
  query: string,
  maxResults = 50
): Promise<GmailMessage[]>

// Fetch a single message by ID  
export async function getMessage(
  env: Env,
  messageId: string
): Promise<GmailMessage>
```

The Gmail REST API base URL is `https://gmail.googleapis.com/gmail/v1/users/me/`.

---

## Step 2: Sample inspection — DO THIS BEFORE WRITING PARSERS

**This step is mandatory.** Before writing any parser, fetch real samples from Gmail and inspect them.

For each vendor (Amazon, Venmo, Apple, Etsy), run the following process:

### 2a. Find the right search query

Test these queries against the real Gmail account and log what comes back:
```
Amazon:   from:auto-confirm@amazon.com OR from:ship-confirm@amazon.com subject:"Your Amazon.com order"
Venmo:    from:venmo@venmo.com
Apple:    from:no_reply@email.apple.com subject:"Your receipt from Apple"
Etsy:     from:transaction@etsy.com OR from:support@etsy.com subject:"receipt"
```

Adjust queries until you reliably find the right emails. Document the final queries.

### 2b. Fetch 3 samples per vendor

For each vendor, fetch 3 real messages. Log:
- The exact `subject` line
- The exact `from` address
- Key fields in the body (look for: amount, date, merchant/counterparty, item names, order ID, memo)
- Any format variations between the 3 samples

Create `apps/cfo/docs/email-samples.md` documenting what you find. This document is the ground truth for the parsers.

### 2c. Identify extraction fields per vendor

From the samples, determine exactly what can be extracted:

| Vendor | Extractable fields |
|---|---|
| Amazon | order_id, order_date, total_amount, items[], seller_name, shipping_address |
| Venmo | transaction_type (sent/received/charged), amount, counterparty_name, memo, date |
| Apple | receipt_id, date, total_amount, items[], app_name |
| Etsy | order_id, date, total_amount, seller_name, items[] |

If a field isn't reliably present across samples, mark it as optional and handle null gracefully.

---

## Step 3: Write the parsers

Create one file per vendor in `src/lib/email-parsers/`:
- `amazon.ts`
- `venmo.ts`
- `apple.ts`
- `etsy.ts`

Each file exports one pure function:

```typescript
// amazon.ts
export interface AmazonContext {
  order_id: string;
  order_date: string;
  total_amount: number;
  items: Array<{ name: string; price: number }>;
  seller_name?: string;
}

export function parseAmazonEmail(message: GmailMessage): AmazonContext | null
```

Rules for all parsers:
- Return `null` if the email doesn't match (not an error — just not this type)
- Never throw — wrap in try/catch and return null on parse failure
- Extract amounts as numbers (strip `$`, commas, parse float)
- Extract dates as ISO strings (YYYY-MM-DD)
- Log a warning (not error) when a field is expected but missing

**Read the CFO parsers for vendor quirks** before writing yours:
- Apple uses receipt IDs matching `/M\d{9,}/` — check if this is still true in your samples
- Etsy sometimes sends forwarded-style emails where the date is in the body — check samples
- Venmo subject lines distinguish sent vs. received vs. charged — parse all three
- Amazon sends separate order confirmation and shipment emails — decide which to parse (order confirmation is cleaner)

---

## Step 4: Transaction matching

Create `src/lib/email-matchers/match.ts`:

```typescript
export interface MatchCandidate {
  transaction_id: string;
  date: Date;
  amount: number;
  description: string;
}

export interface MatchResult {
  transaction_id: string;
  score: number;
  match_type: 'exact' | 'probable' | 'possible';
}

export function scoreMatch(
  candidate: MatchCandidate,
  parsed: { amount: number; date: string }
  vendorHint: string   // e.g. 'amazon', 'venmo', 'apple', 'etsy'
): number
```

Scoring rules (adapt from CFO but verify against your samples):

**Amazon:** Base 50. Date within ±4 days forward (orders post after confirmation): +25 scaled by closeness. Description contains 'amazon': +25. Threshold: 60.

**Venmo:** Base 50. Amount exact match: +40. Date within ±2 days: +20. Description contains 'venmo': +20. Threshold: 70 (Venmo amounts are always exact).

**Apple:** Base 50. Amount exact match: +35. Date within ±2 days: +20. Description contains 'apple': +25. Threshold: 65.

**Etsy:** Base 50. Amount within $0.01: +35. Date within ±5 days: +20. Description contains 'etsy': +25. Threshold: 60.

The CFO's calibrated weights are in `apps/cfo/src/lib/amazon.ts`, `venmo.ts`, etc. — read them, but validate against your samples before committing.

---

## Step 5: Email sync orchestration

Create `src/lib/email-sync.ts`:

```typescript
export async function runEmailSync(env: Env, vendors?: string[]): Promise<EmailSyncResult>
```

For each vendor in scope:
1. Fetch unprocessed messages (those NOT in `email_processed` table — see Step 6)
2. Parse each message
3. If parse succeeds: find matching `raw_transaction` via `scoreMatch`
4. If match score ≥ threshold:
   - Update `raw_transactions.supplement_json` with vendor context
   - If transaction was `status = 'waiting'` for this vendor → update to `'staged'`
5. Mark message as processed in `email_processed` table regardless of parse success (but log failures)

---

## Step 6: Database additions

Add to `migrations/0002_email_tables.sql`:

```sql
CREATE TABLE email_processed (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  vendor        TEXT NOT NULL CHECK (vendor IN ('amazon', 'venmo', 'apple', 'etsy')),
  message_id    TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  parse_success BOOLEAN NOT NULL DEFAULT false,
  match_found   BOOLEAN NOT NULL DEFAULT false,
  transaction_id TEXT REFERENCES raw_transactions(id),
  error_message TEXT,
  UNIQUE (vendor, message_id)
);

CREATE INDEX idx_email_processed_vendor_message ON email_processed(vendor, message_id);
```

Also add to `gather_accounts`: a method to mark a transaction as `waiting_for` a specific vendor. When Teller syncs a transaction that looks like it could have email enrichment (e.g., description contains 'venmo', 'amazon', 'apple', 'etsy'), set `status = 'waiting'` and `waiting_for = 'email_venmo'` etc. The email sync resolves these.

---

## Step 7: Route and cron integration

Add to `src/routes/gmail.ts`:
- `POST /gmail/sync` — trigger email sync for all vendors
- `POST /gmail/sync/:vendor` — trigger sync for one vendor
- `GET /gmail/status` — show last sync time and counts per vendor

Add to nightly cron in `src/index.ts`:
```typescript
// After Teller sync
await runEmailSync(env);
```

Add to `src/routes/health.ts` response:
- Last email sync timestamp per vendor
- Count of unresolved `email_processed` parse failures

---

## Step 8: Validation

For each vendor, verify:
1. The search query finds the right emails in the real Gmail account
2. The parser extracts the expected fields from all 3 samples
3. The matcher correctly scores a known email+transaction pair
4. A full sync run completes without errors and updates `supplement_json` on matching transactions
5. The `email_processed` dedup table prevents re-processing on second run

Document any vendor where fewer than 3 samples were available or where the parser handles a format variation differently.

---

## Acceptance Criteria

1. `docs/email-samples.md` exists with documented samples and field extraction for all 4 vendors
2. All 4 parsers compile and return the correct type or null
3. `scoreMatch` produces correct scores when tested against known email+transaction pairs
4. Full email sync run logs correctly: N messages scanned, N parsed, N matched
5. Re-running sync immediately after doesn't re-process any messages
6. No classification state is touched anywhere in this module — search the code for any write to `transactions.status`, `transactions.entity_id`, or `transactions.category_id` and confirm there are none

**Do not proceed to Phase 1c until Step 8 validation is complete for all vendors.**
