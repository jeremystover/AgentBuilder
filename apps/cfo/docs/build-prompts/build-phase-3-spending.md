# Build Prompt — Phase 3: Spending Module

**Session goal:** Build Module 4 (Spending) — plan-vs-actual comparison, charts, tables, category groups, saveable views, and income tab.

**Before writing any code:** Read `apps/cfo/CLAUDE.md`. Read the Module 4 section in `docs/family-finance-spec.md`. Read `apps/cfo/src/web/components/drilldowns/BudgetView.tsx` from `main` via `git show main:apps/cfo/src/web/components/drilldowns/BudgetView.tsx` — adapt the SummaryStat grid and progress bar layout.

**Phases 1 and 2 must be complete before starting this session.**

---

## What Phase 3 Builds

- Saveable named spending views (plan + date range + entity + category selection)
- Aggregated category groups (reusable, saved globally)
- Expense tab: actual vs. plan chart + period table
- Income tab: same structure, separate tab
- Summary cards (total spent, planned, delta, projected)
- Multi-plan comparison mode
- Pro-ration logic for partial periods
- Unreviewed transaction alert

---

## Step 1: Database additions

Create `migrations/0007_spending.sql`:

```sql
CREATE TABLE category_groups (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE category_group_members (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  group_id    TEXT NOT NULL REFERENCES category_groups(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  UNIQUE (group_id, category_id)
);

CREATE TABLE spending_views (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL,
  plan_ids        TEXT[] NOT NULL DEFAULT '{}',
  date_preset     TEXT,
  date_from       DATE,
  date_to         DATE,
  entity_ids      TEXT[] NOT NULL DEFAULT '{}',
  category_ids    TEXT[] NOT NULL DEFAULT '{}',
  group_ids       TEXT[] NOT NULL DEFAULT '{}',
  period_type     TEXT NOT NULL DEFAULT 'monthly'
                  CHECK (period_type IN ('monthly', 'annual')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## Step 2: Pro-ration utility

Create `src/lib/prorate.ts`. This is used throughout the Spending module.

```typescript
// Given a plan's monthly or annual amount for a category,
// return the expected amount for a (possibly partial) period.
export function prorateAmount(
  baseAmount: number,
  periodType: 'monthly' | 'annual',
  periodStart: Date,
  periodEnd: Date,
  reportingPeriod: 'monthly' | 'annual'
): number

// Generate an array of period buckets between two dates
export function generatePeriods(
  from: Date,
  to: Date,
  periodType: 'monthly' | 'annual'
): Array<{ start: Date; end: Date; label: string; isFuture: boolean }>
```

Rules:
- Monthly plan amounts: divide by days in month × days in period (for partial months)
- Annual plan amounts: divide by 365 × days in period; annotate as annualized
- Partial first/last periods always pro-rated automatically
- `isFuture`: true if period start is after today

---

## Step 3: Spending data engine

Create `src/lib/spending-engine.ts`:

```typescript
export interface SpendingReport {
  periods: Period[];
  categories: CategoryRow[];
  summary: SummaryCards;
  unreviewedCount: number;
  plans: PlanMeta[];
}

export interface CategoryRow {
  category_id: string;
  category_name: string;
  is_group: boolean;
  periods: Array<{
    actual: number | null;       // null if future
    planned: number;             // pro-rated plan amount
    delta: number | null;        // null if multi-plan or future
    projected: number | null;    // null if past
  }>;
  total_actual: number;
  total_planned: number;
  total_delta: number | null;
}

export async function buildSpendingReport(
  db: postgres.Sql,
  params: {
    planIds: string[];
    dateFrom: Date;
    dateTo: Date;
    entityIds: string[];
    categoryIds: string[];
    groupIds: string[];
    periodType: 'monthly' | 'annual';
  }
): Promise<SpendingReport>
```

Key logic:
- Query approved transactions filtered by entity and category
- For each period bucket: sum actuals from transactions
- For each period bucket: calculate pro-rated planned amount from plan(s)
- Delta = actual − planned (single plan only; null if multi-plan)
- Projected = (actuals_to_date / days_elapsed) × days_remaining (future periods only)
- Unreviewed count: query raw_transactions in date range not yet approved

---

## Step 4: Spending routes

Create `src/routes/spending.ts`:

```
GET  /api/spending/report          — generate report (query params: planIds, dateFrom, dateTo, entityIds, categoryIds, groupIds, periodType)
GET  /api/spending/views           — list saved views
POST /api/spending/views           — save a new view
PUT  /api/spending/views/:id       — update a view
DELETE /api/spending/views/:id     — delete a view
GET  /api/spending/groups          — list category groups
POST /api/spending/groups          — create a group
PUT  /api/spending/groups/:id      — update a group
DELETE /api/spending/groups/:id    — delete a group
GET  /api/plans/active             — get the currently active plan id
PUT  /api/plans/active             — set the active plan id
```

---

## Step 5: SpendingView UI

Create `src/web/components/drilldowns/SpendingView.tsx`.

### 5a. Configuration bar

Horizontal bar at top. Controls:

- **View selector** — dropdown of saved named views + "Unsaved" if modified. "Save view" button appears when config differs from the loaded view.
- **Plan selector** — multi-select of active/draft plans. First selected is primary (used for delta). Badge shows active plan with a star.
- **Date range** — presets (This Month, This Quarter, This Year, Last 12 Months, Custom) + start/end pickers
- **Period toggle** — Monthly / Annual. Smart default: if range > 24 months → Annual.
- **Entity filter** — multi-select
- **Category / group selector** — multi-select combining individual categories and saved groups. Groups show a stacked-layers icon.

### 5b. Unreviewed alert

If `unreviewedCount > 0`:
```
Banner: "You have $X in unreviewed transactions in this period. [Review now →]"
```
Non-blocking. Always show when relevant.

### 5c. Summary cards

Row of 6 cards above the chart:

| Card | Single plan | Multi-plan |
|---|---|---|
| Total Spent | actuals sum | actuals sum |
| Total Planned (to date) | plan sum through today | hidden |
| Δ vs. Plan | over/under + % | "Multiple plans selected" |
| Projected End Total | trending spend at end date | trending spend |
| Plan End Total | full plan amount at end date | hidden |
| Projected Δ | projected − plan | hidden |

### 5d. Chart (Recharts)

Line chart. Use Recharts from the existing stack.

**Lines:**
- Actual: solid line, one per selected category/group (each its own color)
- Plan (primary): dotted line, same color as its actual counterpart
- Plan (additional): dotted lines, distinct colors
- Combined total: heavier weight, neutral color (toggleable)

**Temporal zones:**
- Past zone: normal background
- Future zone: light gray background fill
- Vertical reference line at today

**Interactions:**
- Legend checkboxes: toggle visibility (separate from inclusion in analysis)
- Hover tooltip: shows all line values at that date
- Click a period: drills to transaction list for that category+period

### 5e. Period table

Below the chart. Rows = categories/groups. Columns = periods + Total.

**Single plan — each cell shows:**
```
Actual: $X
Planned: $Y
Δ: +/- $Z (colored)
```

**Multi-plan — each cell shows:**
```
Actual: $X
Plan A: $Y
Plan B: $Z
```
No delta column in multi-plan mode.

**Future periods:** Show planned amount + projected actual in italic. Past periods: show real actuals.

**Total column:** Sum across all periods.

Category rows are expandable if the row is a group (shows constituent categories beneath it).

### 5f. Income tab

Separate tab alongside the Expenses tab. Identical structure (summary cards, chart, table) but:
- Queries income categories only
- Delta color logic reversed (over-plan income = green)
- Chart Y-axis labeled "Income" not "Spending"

---

## Step 6: Category group manager

Small modal/drawer accessible from the category selector: "Manage Groups."

- List of existing groups with member categories shown as chips
- Add group: name + category multi-select
- Edit: rename, add/remove members
- Delete: confirmation

Groups are global — they appear in the category selector on any spending view.

---

## Step 7: MCP tool additions

Add to `src/mcp-tools.ts`:

```typescript
{
  name: "spending_summary",
  description: "Show spending vs. plan for a time period. Returns category-level actuals, planned amounts, and over/under deltas. Good for 'how are we tracking against budget this month' questions.",
  inputSchema: {
    type: "object",
    properties: {
      period: { type: "string", enum: ["this_month", "last_month", "this_quarter", "ytd", "custom"] },
      date_from: { type: "string" },
      date_to: { type: "string" },
      entity_slug: { type: "string" },
      category_slugs: { type: "array", items: { type: "string" } }
    }
  }
}
```

Update `src/web-chat-tools.ts` to replace `transactions_summary` with `spending_summary` — the spending engine gives richer output. Keep total tool count at ≤10.

---

## Acceptance Criteria

1. Spending report generates correctly for a date range with approved transactions
2. Pro-ration is correct for partial first and last months
3. Chart renders with correct past/future zone shading and today marker
4. Multi-plan mode hides delta columns and shows plan lines side-by-side
5. A named view can be saved, recalled, and modified
6. Category groups work: creating a group and selecting it aggregates the right transactions
7. Income tab shows income categories separately from expenses
8. Unreviewed alert appears when unreviewed transactions exist in the date range
9. Clicking a chart data point shows the transactions for that category+period
