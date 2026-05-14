# Build Prompt — Phase 6: Scenarios — Tax Configuration & Single-Pass Projection Engine

**Session goal:** Build the tax configuration system and the single-pass forward projection engine. After this phase, a scenario can be defined, run as an async job, and produce a full net worth trajectory with basic flags. No optimization yet — that is Phase 7.

**Before writing any code:** Read `apps/cfo/CLAUDE.md`. Read Phases 3, 4, and 5 of `docs/family-finance-scenarios.md` — the tax calculation functions, Social Security logic, RMD tables, and projection algorithm are fully specified there with pseudocode. The tax law reference data (brackets, NIIT thresholds, QBI rules) is also in that document.

**Phase 5 (Account Setup) must be complete before starting this session.**

---

## What Phase 6 Builds

- User profile (DOB, filing status, state residence timeline)
- Tax bracket configuration pre-loaded for federal, CA, VT
- Deductions configuration (mortgage interest auto-calc, SALT, charitable)
- Capital gains configuration
- Scenario definition UI (start/end date, plan selection, accounts, allocation rules)
- Async projection engine (Cloudflare Queue consumer)
- Single-pass projection: cash flow + account growth + basic allocation + flags
- Tax calculation: ordinary income + LTCG/STCG + state (Phase 6 scope)
- Scenario results: net worth chart + annual summary table + flags panel
- Social Security income modeling
- 529 withdrawal modeling

**Phase 7 adds:** AMT, NIIT, QBI, depreciation recapture, two-pass optimization, Roth conversions.

---

## Step 1: Database additions

Create `migrations/0012_tax_config.sql`:

```sql
CREATE TABLE user_profiles (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name                    TEXT NOT NULL,
  role                    TEXT NOT NULL DEFAULT 'self' CHECK (role IN ('self', 'spouse')),
  date_of_birth           DATE NOT NULL,
  expected_retirement_date DATE
);

CREATE TABLE state_residence_timeline (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  state           TEXT NOT NULL,
  effective_date  DATE NOT NULL
);

CREATE TABLE tax_bracket_schedules (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  year              INTEGER NOT NULL,
  filing_status     TEXT NOT NULL,
  jurisdiction      TEXT NOT NULL,   -- 'federal' | 'CA' | 'VT' | etc.
  brackets_json     JSONB NOT NULL,  -- [{floor, ceiling, rate}]
  standard_deduction NUMERIC(12,2),
  created_by        TEXT NOT NULL DEFAULT 'system'
);

CREATE TABLE capital_gains_config (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  year            INTEGER NOT NULL,
  jurisdiction    TEXT NOT NULL,
  ltcg_brackets_json JSONB,         -- [{floor, ceiling, rate}]
  niit_rate       NUMERIC(6,4) DEFAULT 0.038,
  niit_threshold  NUMERIC(12,2) DEFAULT 250000,
  stcg_as_ordinary BOOLEAN DEFAULT true
);

CREATE TABLE tax_deduction_config (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type          TEXT NOT NULL,   -- 'salt' | 'charitable' | 'mortgage_interest' | 'other'
  label         TEXT,
  annual_amount NUMERIC(12,2),
  effective_date DATE NOT NULL,
  source        TEXT DEFAULT 'manual'  -- 'manual' | 'auto_mortgage'
);

-- Seed user profiles
INSERT INTO user_profiles (id, name, role, date_of_birth) VALUES
  ('up_jeremy', 'Jeremy', 'self',   '1976-01-01'),  -- placeholder DOB — Jeremy to update
  ('up_elyse',  'Elyse',  'spouse', '1976-01-01');  -- placeholder DOB — Elyse to update

-- Seed state residence timeline  
INSERT INTO state_residence_timeline (state, effective_date) VALUES
  ('CA', '2000-01-01'),   -- California (historical)
  ('VT', '2027-07-01');   -- Vermont (planned relocation)
```

---

## Step 2: Pre-load tax bracket data

Create `migrations/0013_seed_tax_brackets.sql`.

Pre-load the bracket data from `docs/family-finance-scenarios.md` Section 3 (Tax Configuration Reference). Load at minimum:

**Federal 2025 MFJ ordinary income brackets** (7 brackets, standard deduction $29,200)
**Federal 2025 MFJ LTCG brackets** (3 tiers: 0% / 15% / 20%)
**California 2025 MFJ brackets** (9 brackets + 1% Mental Health surcharge)
**Vermont 2025 MFJ brackets** (4 brackets)

Format each bracket array as JSONB:
```json
[{"floor": 0, "ceiling": 23200, "rate": 0.10}, ...]
```

Also seed `capital_gains_config` for federal 2025 (NIIT rate 0.038, threshold $250,000).

**Note:** The scenarios supplemental has the exact bracket numbers — copy them directly. Do not use approximate values.

---

## Step 3: Tax calculation engine

Create `src/lib/tax-engine.ts`.

Implement Phase 4 (simplified) tax calculation as defined in `docs/family-finance-scenarios.md`:

```typescript
export interface TaxYearInputs {
  year: number;
  ordinary_income: number;    // W2 + business + SS taxable portion
  capital_gains_lt: number;
  capital_gains_st: number;
  ss_gross: number;           // before taxability calculation
  filing_status: string;
  state: string;              // resolved from timeline for this year
}

export interface TaxYearResult {
  federal_ordinary_tax: number;
  ltcg_tax: number;
  state_tax: number;
  total_tax: number;
  effective_rate: number;
  marginal_rate: number;
  ss_taxable_amount: number;
  deductions_used: number;
  itemized_vs_standard: 'itemized' | 'standard';
  breakdown: Record<string, number>;
}

export async function calculateTax(
  db: postgres.Sql,
  inputs: TaxYearInputs
): Promise<TaxYearResult>
```

Implement these functions (all specified with pseudocode in the scenarios supplemental):
- `applyBrackets(income, brackets)` — progressive bracket calculation
- `calculateOrdinaryTax(income, year, filingStatus, jurisdiction)` — loads brackets from DB
- `calculateLtcgTax(gains, totalOrdinaryIncome, year)` — LTCG stacking on top of ordinary
- `calculateSsTaxableIncome(ssGross, otherAgi, taxExemptInterest)` — combined income test
- `getItemizedDeductions(year)` — sums configured deductions; auto-calculates mortgage interest from account amortization schedule

**Phase 6 scope: ordinary income + LTCG/STCG + state only.** AMT, NIIT, QBI are Phase 7.

---

## Step 4: Projection engine (single-pass)

Create `src/lib/projection-engine.ts`.

Implement the single-pass algorithm from Phase 4 of `docs/family-finance-scenarios.md`. The engine:
1. Runs year-by-year (monthly for first 24 months, annual beyond)
2. Gets cash flow from the selected Module 3 plan via `resolvePlan()`
3. Applies account growth at each account's configured rate
4. Amortizes debt accounts per their schedule
5. Calculates tax for the year
6. Allocates surplus or draws deficit per the configured waterfall
7. Records period results and flags
8. Accumulates all results in memory — writes to DB as a single transaction at the end

**Critical architecture note:** The engine must accumulate all `scenario_period_results`, `scenario_flags`, and `allocation_decisions` rows in a JavaScript array during computation. Write the entire snapshot in one `db.transaction()` call at the end. Never write period-by-period to the database.

Implement:
- `runProjection(params): Promise<ProjectionResult>` — full single-pass run
- `applyAccountGrowth(accounts, periodDays)` — compound growth for assets
- `amortizeMortgage(account, periodDays)` — principal reduction
- `allocateSurplus(surplus, accounts, rules, lookAheadPeriods)` — surplus waterfall
- `drawDeficit(deficit, accounts, rules, db)` — deficit waterfall with tax calculation
- `evaluateFlags(periodResult, accounts, profiles)` — generate flags per the list in the scenarios supplemental

**RMD logic:** Use the IRS Uniform Lifetime Table factors from the scenarios supplemental. Check each retirement account owner's age at year start — if ≥ 73, calculate RMD and add it to ordinary income regardless of cash flow needs.

**Social Security:** Start SS income in the year each person reaches their elected start age. Apply the adjustment factor from the SS table in the scenarios supplemental.

**529 withdrawals:** Process per the withdrawal_schedule in each account's config_json.

---

## Step 5: Async job infrastructure

The projection engine runs as a Cloudflare Queue consumer. Wire this up in `src/index.ts`:

```typescript
export default {
  fetch: handleFetch,
  scheduled: handleScheduled,
  queue: handleQueue,   // NEW
};

async function handleQueue(batch: MessageBatch<ScenarioJobMessage>, env: Env) {
  for (const message of batch.messages) {
    const { scenario_id, snapshot_id } = message.body;
    try {
      await runAndSaveProjection(env, scenario_id, snapshot_id);
      message.ack();
    } catch (err) {
      // Update job status to 'failed' with error message
      await markJobFailed(env, snapshot_id, String(err));
      message.ack(); // ack to prevent infinite retry on hard failures
    }
  }
}
```

**Job lifecycle:**
1. `POST /api/scenarios/:id/run` → inserts a `scenario_jobs` row (status='queued'), sends to Queue, returns `{job_id, snapshot_id}`
2. Queue consumer picks up, runs projection, writes snapshot, updates job to 'complete'
3. `GET /api/scenarios/:id/status` → returns current job status + snapshot_id when complete
4. UI polls this endpoint every 5 seconds while status = 'running' or 'queued'

---

## Step 6: Scenario definition UI

Extend `ScenariosView.tsx` to add a Scenarios tab (alongside the Accounts and Net Worth tabs from Phase 5).

### 6a. Scenario list

Per scenario:
- Name, date range, plan used
- Status badge: Draft / Running / Complete / Stale / Failed
- End-state net worth (from last run)
- Last run timestamp
- Actions: Run, View Results, Edit, Duplicate, Archive

**Status polling:** While a scenario has status = 'running', poll `GET /api/scenarios/:id/status` every 5 seconds. Show a progress message from the job record if available. Auto-refresh results when complete.

### 6b. Scenario editor

Form for creating/editing a scenario:
- Name
- Start date / End date (support up to 40 years forward)
- Plan selector (one plan, from Module 3)
- Account checkboxes (select which accounts to include — defaults to all active)
- Allocation rules configurator: two ordered lists (surplus waterfall, deficit waterfall), each with drag-to-reorder. Items from the standard waterfall per spec.

### 6c. Results view

After a scenario run completes:

**Net worth chart** (Recharts):
- Total net worth line (heavy, blue)
- Individual account lines (toggleable)
- Past zone (gray/white) / Future zone (light blue background)
- Today marker
- Key event markers: retirement dates, SS start, 529 withdrawal years, planned liquidity events

**Annual summary table:**
Rows = projection years. Columns:

| Year | Gross Income | Tax | Net After Tax | Account Growth | Net Worth (EOY) | Δ Net Worth | Flags |
|---|---|---|---|---|---|---|---|

Flag cells link to the flags panel.

**Flags panel:**
All flags sorted by date. Flag types from the scenarios supplemental: FUNDING_GAP (critical), PENALTY_WITHDRAWAL (critical), LOW_LIQUIDITY (warning), RMD_DUE (info), MORTGAGE_PAYOFF (info), SS_BEGINS (info). Each links to the relevant year in the table.

---

## Step 7: Tax configuration UI

Add a **Tax & Profile** section to the Scenarios module (or under Settings).

- **User Profiles**: DOB, retirement date per person (pre-filled from seed data)
- **State Timeline**: date-ordered list of state + effective_date. Shows "CA through 2027-06 → VT from 2027-07"
- **Tax Brackets**: shows pre-loaded brackets by year. "Add year" lets user add future-year assumptions. "Apply inflation" adds a % growth to all brackets for projection years
- **Deductions**: mortgage interest (auto from accounts, shows calculated value), SALT cap, charitable, other. Each with effective date for future changes.

---

## Acceptance Criteria

1. Tax calculation is correct for a known income scenario — verify against the bracket tables manually for at least one year
2. SS income starts in the correct projection year at the correct adjusted benefit amount
3. RMD is calculated correctly for a Traditional IRA owner who reaches age 73 in the projection
4. Projection engine runs to completion for a 20-year scenario without error
5. All period results, flags, and allocation decisions written as a single atomic transaction
6. Async job system: `POST /run` → Queue consumer → results available via status poll
7. Funding gap flag fires when liquid balance goes negative in a period
8. Net worth chart renders the full projection with correct past/future shading
9. Annual summary table shows correct year-by-year numbers matching the projection output
