# Build Prompt — Phase 1c: Gather & Review UI

**Session goal:** Build the React SPA for the Gather module (account configuration, sync health dashboard) and the Review module (transaction review queue, bulk actions, individual transaction editing). This is the primary user-facing interface.

**Before writing any code:** Read `apps/cfo/CLAUDE.md`. Read the existing UI files you will be copying — list in Step 1. Then read `apps/cfo/src/web/components/drilldowns/ReviewQueueView.tsx` fully — the layout and bulk-selection pattern must be reproduced.

**Phases 1a and 1b must be complete before starting this session.**

---

## Step 1: Copy the design system foundation

Copy these files verbatim from `apps/cfo/` to the equivalent path in `apps/cfo/`:

```
apps/cfo/src/web/index.css                    → apps/cfo/src/web/index.css
apps/cfo/src/web/main.tsx                     → apps/cfo/src/web/main.tsx
apps/cfo/src/web/components/ui.tsx            → apps/cfo/src/web/components/ui.tsx
apps/cfo/src/web/utils/txColor.ts             → apps/cfo/src/web/utils/txColor.ts
apps/cfo/src/web/components/ChatPanel.tsx     → apps/cfo/src/web/components/ChatPanel.tsx
```

Then copy `apps/cfo/tailwind.config.ts` and update only the `content` glob:
```ts
content: ["./src/web/**/*.{ts,tsx,html}"],  // update to family-finance paths
```

**Do not modify any copied file's logic or styles.** Only update import paths if they break.

---

## Step 2: Promote these to `ui.tsx`

After copying `ui.tsx`, add these components that are currently inline in CFO screens but should be primitives in the new system:

```typescript
// SummaryStat — used on dashboard-style pages for key numbers
interface SummaryStatProps {
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'success' | 'warn' | 'danger';
}
export function SummaryStat({ label, value, sub, tone }: SummaryStatProps)

// SortTh — table header with sort toggle
interface SortThProps {
  col: string;
  currentSort: string;
  currentDir: 'asc' | 'desc';
  onSort: (col: string) => void;
  children: React.ReactNode;
}
export function SortTh(props: SortThProps)

// ProgressBar — used for budget rows
interface ProgressBarProps {
  value: number;    // 0–1
  tone?: 'success' | 'warn' | 'danger';
}
export function ProgressBar({ value, tone }: ProgressBarProps)

// ConfidenceBadge — AI confidence level as a colored badge
export function ConfidenceBadge({ confidence }: { confidence: number | null })
// Logic: null → neutral; ≥0.9 → ok (green); ≥0.7 → warn (amber); <0.7 → danger (red)
```

---

## Step 3: Router and app shell

Create `src/web/router.ts` — adapt from `apps/cfo/src/web/router.ts`:

```typescript
export type RouteId =
  | 'gather'
  | 'gather_accounts'
  | 'gather_schedule'
  | 'review'
  | 'review_holds'
  | 'transactions'
  | 'reporting'
  | 'planning'
  | 'spending'
  | 'scenarios'
  | 'settings';
```

Create `src/web/components/TopNav.tsx` — adapt from `apps/cfo/src/web/components/TopNav.tsx`:
- Replace the `TABS` array with the new routes above
- Replace the "CFO" brand mark with "Finances" (or whatever feels right — Jeremy to confirm)
- Replace the `<Wallet />` icon with `<BarChart2 />` from lucide-react
- Keep the right-side actions (chat toggle, sign out) exactly as CFO has them

Create `src/web/App.tsx`:
```typescript
// Route-based rendering — each RouteId maps to a view component
// Views not yet built render a <PlaceholderView name="..." /> stub
```

---

## Step 4: Build `GatherView` — account configuration

Create `src/web/components/drilldowns/GatherView.tsx`.

This is the Gather module's settings/health page. Sections:

### 4a. Connection Health Banner
At the top: overall system health. If all sources synced within expected window → green "All sources synced". If any have issues → amber/red with count and "View details".

### 4b. Accounts Table

One row per configured account. Columns:
- Account name + institution
- Source type (badge: Teller / Email / Chrome)
- Entity (dropdown — editable inline)
- Status (Connected / Disconnected / Error / Needs Attention)
- Last synced
- Transactions (last sync count)
- Next scheduled sync
- Active toggle

**Teller accounts**: show a "Reconnect" button when status is disconnected. Call `POST /teller/enroll` to start a new enrollment.

**Email sources**: show each vendor (Amazon, Venmo, Apple, Etsy) as a row. Show the search query being used. Include a "Run sync now" button per vendor. Show parse success rate (successful parses / messages scanned from `email_processed`).

**Add Account** button opens a drawer where the user selects source type and configures.

### 4c. Sync Schedule Panel
One row per source showing:
- Cron expression in human-readable form (e.g., "Daily at 5:00 AM ET")
- Last run timestamp + status
- Next scheduled run
- "Run now" button

### 4d. Recent Sync Log
Last 20 entries from `sync_log` across all sources. Columns: timestamp, source, status, new transactions. Filterable by source.

---

## Step 5: Build `ReviewQueueView` — the core review interface

Create `src/web/components/drilldowns/ReviewQueueView.tsx`.

**Critical:** Read `apps/cfo/src/web/components/drilldowns/ReviewQueueView.tsx` in full before writing this component. The layout, filter panel, and especially the bulk-selection pattern must be reproduced exactly. The data bindings will differ (new schema) but the UX is the same.

### 5a. Filter bar
Horizontal bar above the table. Filters:
- **Search** — free text, filters description + merchant as you type (debounced 200ms)
- **Date range** — start/end date pickers
- **Entity** — multi-select from entities list
- **Category** — multi-select (filterable dropdown)
- **Status** — pending_review / all
- **Confidence** — high (≥0.9) / medium (0.7–0.9) / low (<0.7) / rule-matched
- **Account** — multi-select

Filters combine with AND. Active filter count shown as a badge. "Clear all" link.

### 5b. Bulk action bar
Shows when any rows are selected. Contains:

```
[✓ N selected]  [Set entity ▾]  [Set category ▾]  [Add note]  [Approve]  [Mark transfer]  [Mark reimbursable]
```

**The three-state selection pattern** (copy this exactly from CFO's `ReviewQueueView`):
1. Page-level checkbox in table header: selects/deselects visible rows on current page. Shows `indeterminate` state when partial selection.
2. When all visible rows are selected, show a banner: "All N rows on this page are selected. Select all N matching rows instead →"
3. Clicking that link sets `selectedAllFiltered = true` — bulk actions apply the filter server-side, not just visible rows.
4. Selection is a `Set<string>` of transaction IDs, persisted across page navigation.

This distinction matters: if you're approving 1,400 rule-matched transactions, you don't want to page through them — you filter to confidence=high and select all filtered.

### 5c. Transaction table

Columns:
| Column | Notes |
|---|---|
| Checkbox | Part of bulk-select |
| Date | Sortable |
| Description | Primary identifier; merchant on second line in muted text |
| Amount | Right-aligned; color from `txColor` utility; sortable |
| Account | Muted |
| Proposed entity | Editable dropdown inline |
| Proposed category | Editable dropdown inline |
| Confidence | `ConfidenceBadge` |
| Method | Small badge: rule / ai / manual |
| Actions | "→" to open detail drawer |

Clicking a row opens the detail drawer (see 5d). Rows with `is_transfer` or `is_reimbursable` show a small tag.

### 5d. Transaction detail drawer

Slides in from the right. Shows:
- Full transaction details (date, amount, description, merchant, account)
- Supplement context (if email enrichment exists — show items, order ID, counterparty, memo)
- AI reasoning notes (the `ai_notes` field — why it was categorized this way, what was considered)
- **Entity selector** (dropdown)
- **Category selector** (dropdown, filtered by entity type)
- **Notes field** (free text — saved to `human_notes`)
- **Split transaction** button (opens split modal)
- Toggle: Transfer / Reimbursable
- **Approve** button (single click — saves + approves)
- **Propose rule** link — opens `ProposeRuleModal`

### 5e. Propose Rule Modal

Adapt from `apps/cfo/src/web/components/ProposeRuleModal.tsx`. Shows:
- The transaction's description
- A suggested rule (pre-filled: description_contains = first meaningful token of description)
- Entity + category selectors (pre-filled from current classification)
- "Add rule" → `POST /rules`

### 5f. Holds section

Separate tab or collapsible section: transactions in `status = 'waiting'`. Shows:
- What each transaction is waiting for (e.g., "Waiting for Venmo email match")
- Age of hold
- **Advance anyway** button — moves to pending_review without supplement data, flags as incomplete

---

## Step 6: Build `TransactionsView` — approved transaction history

Create `src/web/components/drilldowns/TransactionsView.tsx`.

Simpler than ReviewQueueView — read-only history of approved transactions.
- Same filter bar as ReviewQueueView
- Same table columns but without edit controls (entity/category shown as text, not dropdowns)
- Clicking a row opens a read-only detail view
- "Edit" button in the detail view re-opens editing — sets status back to pending_review

---

## Step 7: REST endpoints for the UI

Add these to `src/routes/` and wire in `src/index.ts`:

```
GET  /api/web/snapshot           — dashboard summary (pending review count, recent syncs)
GET  /api/review                 — list review queue (with filters, pagination)
POST /api/review/bulk            — bulk approve/categorize (filter OR id list)
GET  /api/review/:id             — single transaction detail
POST /api/review/:id/approve     — approve one transaction
PUT  /api/review/:id             — update entity/category/notes
GET  /api/transactions           — approved transactions list
PUT  /api/transactions/:id       — re-open for edit (sets status = pending_review)
POST /api/transactions/:id/split — split transaction
GET  /api/accounts               — gather accounts list
PUT  /api/accounts/:id           — update account entity/active
POST /api/rules                  — create a rule
GET  /api/rules                  — list active rules
GET  /api/gather/status          — sync health for all sources
POST /api/gather/sync/:source    — trigger manual sync
```

---

## Step 8: Auto-categorization flow (Review module backend)

When a `raw_transaction` moves from `staged` → `pending_review`, run this sequence:

1. **Rule check** — query `rules` table for matching rules (use `match_json` criteria). If match: set entity/category/method='rule'/confidence=1.0 → ready for human review.

2. **AI classification** (if no rule matched) — call the LLM via `@agentbuilder/llm` with:
   - Transaction description, merchant, amount, date
   - Source account (entity hint)
   - Geographic hint if available
   - `supplement_json` context (email enrichment)
   - Top 5 similar past transactions and how they were classified
   - Full `knowledge_file` content (from the `knowledge_file` table)
   - All active categories with their descriptions
   - Request: entity + category + confidence + reasoning + alternatives

3. Store `ai_notes`, `ai_confidence`, `entity_id`, `category_id` on the transaction.

Create `src/lib/classify.ts` for this logic. Use `@agentbuilder/llm`'s tier system for the LLM call, not a hardcoded model ID.

---

## Acceptance Criteria

1. SPA loads at `/` with correct navigation tabs
2. Gather page shows all configured accounts with sync status
3. Review queue shows pending transactions with filter, sort, and pagination
4. Bulk-select works: page-level checkbox, select-all-filtered banner, persistent selection across pages
5. Individual transaction drawer opens with AI notes and editable fields
6. Approving a transaction moves it to the Transactions view
7. Propose-rule modal creates a rule and it appears in the rules list
8. Holds section shows waiting transactions with "Advance anyway" working
9. Auto-categorization runs when a raw transaction is staged — rule matches are applied before AI

**Do not proceed to Phase 1d until the review flow works end-to-end with real Teller transactions.**
