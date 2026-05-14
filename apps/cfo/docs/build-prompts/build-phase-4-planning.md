# Build Prompt — Phase 4: Planning Module

**Session goal:** Build Module 3 (Planning) — foundation and modification plans, category amount configuration, time-based adjustments, one-time items, plan inheritance, and forecasting view.

**Before writing any code:** Read `apps/cfo/CLAUDE.md`. Read the Module 3 section in `docs/family-finance-spec.md` fully — the plan inheritance model (Foundation → Modification chain) is the most complex part and must be understood before writing any schema or logic.

**Phase 3 (Spending) must be complete before starting this session.** The Spending module selects an active plan — that plan must exist.

---

## What Phase 4 Builds

- Plan list with Foundation / Modification type distinction
- Plan editor: category amounts, annual/monthly toggle, suggested amounts from history
- Time-based adjustments: fixed rate and scheduled changes
- Plan inheritance: modification plans layer deltas on top of parent
- One-time items (dated expenses and income)
- Forecasting view: long-range cash flow projection
- Duplicate vs. Extend as distinct operations
- Active plan management (used by Spending module)

---

## Step 1: Database schema

Create `migrations/0008_planning.sql`:

```sql
CREATE TABLE plans (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('foundation', 'modification')),
  parent_plan_id  TEXT REFERENCES plans(id),
  start_date      DATE,
  end_date        DATE,
  is_active       BOOLEAN NOT NULL DEFAULT false,  -- true = used by Spending module
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'active', 'archived')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT foundation_has_no_parent CHECK (
    type = 'modification' OR parent_plan_id IS NULL
  )
);

CREATE TABLE plan_category_amounts (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  plan_id         TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  category_id     TEXT NOT NULL REFERENCES categories(id),
  amount          NUMERIC(12,2),        -- null = inherited from parent
  period_type     TEXT NOT NULL DEFAULT 'monthly'
                  CHECK (period_type IN ('monthly', 'annual')),
  override_type   TEXT NOT NULL DEFAULT 'inherited'
                  CHECK (override_type IN ('inherited', 'delta', 'fixed')),
  base_rate_pct   NUMERIC(6,4),         -- annual growth rate (e.g. 0.03 = 3%)
  base_rate_start DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, category_id)
);

CREATE TABLE plan_category_changes (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  plan_category_amount_id TEXT NOT NULL REFERENCES plan_category_amounts(id) ON DELETE CASCADE,
  effective_date          DATE NOT NULL,
  delta_amount            NUMERIC(12,2) NOT NULL,  -- + or - from amount in effect
  notes                   TEXT
);

CREATE TABLE plan_one_time_items (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  item_date   DATE NOT NULL,
  amount      NUMERIC(12,2) NOT NULL,
  category_id TEXT REFERENCES categories(id),
  notes       TEXT
);
```

---

## Step 2: Plan resolution engine

Create `src/lib/plan-resolver.ts`. This is the core algorithmic piece of the Planning module.

```typescript
// Resolve the effective category amounts for a plan at a given date.
// Walks the Foundation → Modification chain, applying deltas in order.
export async function resolvePlan(
  db: postgres.Sql,
  planId: string,
  asOf: Date
): Promise<Map<string, ResolvedCategoryAmount>>

export interface ResolvedCategoryAmount {
  category_id: string;
  amount: number;           // effective amount after chain resolution
  period_type: 'monthly' | 'annual';
  monthly_amount: number;   // always normalized to monthly for comparison
  source_plan_id: string;   // which plan in the chain set this value
  override_type: 'foundation' | 'delta' | 'fixed' | 'inherited';
  // Time-based adjustments applied to the base amount as of `asOf`:
  adjusted_for_rate: boolean;
  adjusted_for_changes: boolean;
}
```

**Chain resolution algorithm:**
1. Load the plan's full ancestor chain (recursively up to the foundation)
2. Start with foundation's amounts
3. For each modification in order (oldest first):
   - `override_type = 'fixed'`: replace entirely
   - `override_type = 'delta'`: add delta to current value
   - `override_type = 'inherited'`: keep current value unchanged
4. Apply time-based adjustments to the resolved amount:
   - Fixed rate: compound from base_rate_start to asOf date
   - Scheduled changes: sum all deltas with effective_date ≤ asOf

**New category handling:** When a category is added to the system after a plan was created, it appears in the editor with amount = $0. Auto-add behavior per spec.

---

## Step 3: Planning routes

Create `src/routes/planning.ts`:

```
GET    /api/plans                        — list all plans (with chain metadata)
POST   /api/plans                        — create plan
GET    /api/plans/:id                    — get plan detail
PUT    /api/plans/:id                    — update plan metadata
DELETE /api/plans/:id                    — archive plan (soft delete)
POST   /api/plans/:id/duplicate          — create sibling with same parent
POST   /api/plans/:id/extend             — create child modification plan
GET    /api/plans/:id/resolve            — resolved category amounts at ?asOf= date
GET    /api/plans/:id/forecast           — cash flow forecast (see Step 4)
PUT    /api/plans/:id/set-active         — set as the active plan for Spending module

GET    /api/plans/:id/categories         — category amounts for this plan
PUT    /api/plans/:id/categories/:catId  — set amount/override_type/period_type
GET    /api/plans/:id/categories/:catId/suggest — suggested amount from historical actuals

GET    /api/plans/:id/one-time-items     — list one-time items
POST   /api/plans/:id/one-time-items     — add one-time item
PUT    /api/plans/:id/one-time-items/:itemId  — update
DELETE /api/plans/:id/one-time-items/:itemId  — delete
```

**Duplicate vs. Extend:**
- `POST /api/plans/:id/duplicate` → creates a new plan with `type = original.type`, `parent_plan_id = original.parent_plan_id`. Copies all category amounts and one-time items. Name = "Copy of {original.name}".
- `POST /api/plans/:id/extend` → creates a new plan with `type = 'modification'`, `parent_plan_id = id`. Starts with no category overrides (all inherited). Name = "{original.name} — Modified".

**Suggested amount endpoint:**
```
GET /api/plans/:id/categories/:catId/suggest?months=12
```
Returns: `{ average_monthly: number; average_annual: number; transaction_count: number; lookback_months: number }`
Queries approved transactions for the category over the lookback period.

---

## Step 4: Forecast engine

Create `src/lib/forecast.ts`:

```typescript
export interface ForecastPeriod {
  period_start: Date;
  period_end: Date;
  label: string;
  period_type: 'month' | 'year';
  total_income: number;
  total_expenses: number;
  net: number;
  one_time_items: OneTimeItem[];
}

export async function generateForecast(
  db: postgres.Sql,
  planId: string,
  from: Date,
  to: Date,
  periodType: 'monthly' | 'annual'
): Promise<ForecastPeriod[]>
```

Logic:
- For each period: resolve plan amounts as of period start
- Sum income categories → `total_income`
- Sum expense categories → `total_expenses`
- Include one-time items falling in each period as discrete items
- `net = total_income − total_expenses`
- Period type: monthly if range ≤ 24 months, annual otherwise (auto), overridable

---

## Step 5: PlansView UI

Create `src/web/components/drilldowns/PlansView.tsx`.

### 5a. Plan list

Left panel. One row per plan:
- Name + type badge (Foundation / Modification)
- Parent plan name (if modification)
- Start/end date
- Status chip (Draft / Active / Archived)
- Active plan marked with a star
- Actions: Edit, Duplicate, Extend, Set Active, Archive

**Plan chain tree view:** Toggle between flat list and a tree view showing Foundation → Modification → Modification hierarchy. Each level is indented.

### 5b. Plan editor (right panel / full page)

Opens when a plan is selected.

**Header:** Plan name (editable inline), type, parent (if modification), start/end dates, status.

**Category grid:**

One row per category. Columns:

| Column | Foundation plan | Modification plan |
|---|---|---|
| Category name | shown | shown |
| Period toggle | Monthly / Annual | Monthly / Annual |
| Amount | editable | editable (with override type selector) |
| Override type | — | Inherited / Delta / Fixed (radio) |
| Parent value | — | shows resolved parent amount |
| Effective value | = amount | = resolved result |
| Suggested | "Use $X avg" button | same |
| Adj. indicator | click to expand | click to expand |

**Adjustment editor (inline expand):**

Two sections:
1. Fixed rate: % per year input + start date
2. Scheduled changes: date-ordered list of `{date, +/- amount}` rows. Add/remove.

Below: "Preview" — shows the effective monthly amount year-by-year for the next 10 years given the current adjustments.

**Modification plan: three-column layout for each row:**
```
Parent value: $800/mo   |   This plan: +$200 (delta)   |   Effective: $1,000/mo
```

**Suggested amount:**
Clicking "Use $X avg" pre-fills the amount field. A "View transactions" link opens a mini transaction list filtered to that category+lookback period, so the user can exclude outliers before accepting the suggestion.

### 5c. One-time items section

Below the category grid. List of items with: name, type (expense/income), date, amount, category.

Add/edit/delete inline. Sorted by date.

### 5d. Forecast view

Separate tab in the plan editor. Shows `generateForecast` output:

- Line chart: income (green), expenses (red/orange), net (blue). X-axis = time.
- One-time items as vertical spike markers with tooltip.
- Toggle: Monthly / Annual view
- Horizon selector: 1yr / 5yr / 10yr / 20yr / custom end date
- Table below chart: period rows × income/expense/net columns

---

## Step 6: Active plan integration

The Spending module reads `plans.is_active = true` to find the current active plan. Ensure only one plan can have `is_active = true` at a time — enforce this in `PUT /api/plans/:id/set-active` by first setting all others to false.

Show the active plan name in the Spending module's configuration bar (already has a plan selector — this just ensures the pre-selected default is the active plan).

---

## Step 7: MCP tool additions

Add to `src/mcp-tools.ts`:

```typescript
{
  name: "plan_forecast",
  description: "Show the cash flow forecast from the active plan: expected income, expenses, and net for each month or year going forward. Good for 'what does our budget look like for the rest of the year' questions.",
  inputSchema: {
    type: "object",
    properties: {
      months_ahead: { type: "number", default: 12, description: "How many months to forecast" },
      period_type: { type: "string", enum: ["monthly", "annual"], default: "monthly" }
    }
  }
}

{
  name: "plan_list",
  description: "List all financial plans with their type (foundation/modification), status, and whether they are the active plan used for budget comparison.",
  inputSchema: { type: "object", properties: {} }
}
```

Update `web-chat-tools.ts` to swap in `plan_forecast` for one of the less-used tools. Keep total at ≤10.

---

## Acceptance Criteria

1. A foundation plan can be created with category amounts — resolved amounts are correct
2. A modification plan correctly inherits from its parent: delta overrides add to parent value, fixed overrides replace it, inherited passes through unchanged
3. Time-based adjustments apply correctly: fixed rate compounds from start date, scheduled changes stack cumulatively
4. Duplicate creates a sibling (same parent), Extend creates a child modification
5. Suggested amounts return correct averages from approved transaction history
6. Forecast generates correct period totals with one-time items appearing in the right periods
7. Setting a plan active updates the Spending module's default plan selection
8. New categories auto-added at $0 to all existing plans
