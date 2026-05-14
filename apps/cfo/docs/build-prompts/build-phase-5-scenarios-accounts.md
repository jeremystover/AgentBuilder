# Build Prompt — Phase 5: Scenarios — Account Setup & Balance History

**Session goal:** Build the foundation of Module 5 (Scenarios) — account configuration for all balance sheet account types, rate schedules, balance history logging, and a historical net worth visualization. No projection engine yet — this phase is purely about getting the data model right and making past balance data visible.

**Before writing any code:** Read `apps/cfo/CLAUDE.md`. Read the Module 5 section in `docs/family-finance-spec.md` AND the full `docs/family-finance-scenarios.md` supplemental — especially Phase 1 (Account Setup) and Phase 2 (Historical View). The account type configurations and their JSON schemas are fully specified there.

**Phase 4 (Planning) must be complete before starting this session.**

---

## What Phase 5 Builds

- All balance sheet account types with type-specific configuration
- Rate schedule editor (base rate + dated changes)
- Balance history log (manual entry + optional Teller balance pull)
- Net worth dashboard: historical chart from recorded data
- Account detail view with actual vs. configured rate comparison
- No projection engine — that is Phase 6

---

## Step 1: Database schema

Create `migrations/0009_scenarios_accounts.sql`.

Copy the schema exactly from Phase 1 of `docs/family-finance-scenarios.md` — it contains the complete table definitions for:
- `scenario_accounts`
- `account_type_config`
- `account_rate_schedule`
- `account_balance_history`

Key notes:
- `account_type_config.config_json` stores JSONB — use Postgres JSONB type, not TEXT
- The JSON schemas per account type are documented in the scenarios supplemental — implement them exactly
- `scenario_accounts.type` enum must include all types listed in the supplemental: `checking`, `brokerage`, `trad_401k`, `roth_ira`, `real_estate_primary`, `real_estate_investment`, `mortgage`, `heloc`, `loan`, `private_equity`, `529`, `social_security`, `other_asset`, `other_liability`

Also create `migrations/0010_scenarios_core.sql` for the scenario management tables (needed even though the engine isn't built yet — Phase 6 will use these):
- `scenarios`
- `scenario_snapshots`
- `scenario_period_results`
- `scenario_flags`
- `allocation_decisions`
- `scenario_jobs`

Copy these schemas from Phase 4 and Phase 7 of `docs/family-finance-scenarios.md`.

---

## Step 2: Account routes

Create `src/routes/scenarios.ts` (will be extended in Phases 6 and 7):

```
GET    /api/scenario-accounts                    — list all accounts
POST   /api/scenario-accounts                    — create account
GET    /api/scenario-accounts/:id                — get account detail
PUT    /api/scenario-accounts/:id                — update account
DELETE /api/scenario-accounts/:id                — archive (soft delete)

GET    /api/scenario-accounts/:id/rate-schedule  — get rate schedule
PUT    /api/scenario-accounts/:id/rate-schedule  — replace rate schedule (array of {base_rate, effective_date})
GET    /api/scenario-accounts/:id/balance-history — list balance history entries
POST   /api/scenario-accounts/:id/balance-history — add a balance entry
PUT    /api/scenario-accounts/:id/balance-history/:entryId — update entry
DELETE /api/scenario-accounts/:id/balance-history/:entryId — delete entry
GET    /api/scenario-accounts/:id/rate-comparison — actual vs. configured rate (see Step 4)
```

---

## Step 3: Type-specific configuration

Each account type has a different set of configuration fields (documented fully in `docs/family-finance-scenarios.md` Phase 1, Section 5.3.4). The API stores these as `account_type_config.config_json`.

Implement a validation function `validateAccountTypeConfig(type, config)` that:
- Checks required fields are present per type
- Returns typed errors for missing/invalid fields
- Called on every POST/PUT to account or account type config

The account types with the most complex configs that need careful implementation:
- **Real estate**: purchase_price, purchase_date, accumulated_depreciation
- **Retirement**: owner ('jeremy' | 'elyse'), account_subtype, roth_contribution_basis
- **529**: beneficiary, annual_contribution, withdrawal_schedule array
- **Social Security**: person, fra_monthly_benefit, full_retirement_age, elected_start_age
- **Private equity**: company, grant_type (ISO/NSO/RSU/common), vesting_schedule, liquidity_events

---

## Step 4: Rate comparison calculation

The account detail view shows "configured rate vs. actual rate" between any two balance history entries.

Implement in `src/lib/account-analytics.ts`:

```typescript
export function calculateActualRate(
  startBalance: number,
  endBalance: number,
  startDate: Date,
  endDate: Date
): number {
  // Annualized rate: (endBalance / startBalance) ^ (1 / years) - 1
  const years = (endDate.getTime() - startDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return Math.pow(endBalance / startBalance, 1 / years) - 1;
}

export function getConfiguredRateAtDate(
  rateSchedule: AccountRateScheduleEntry[],
  date: Date
): number {
  // Find the most recent rate schedule entry on or before date
  // Return base_rate of that entry
}
```

---

## Step 5: Net Worth dashboard UI

Create `src/web/components/drilldowns/ScenariosView.tsx` — this component hosts all scenario-related views including the account setup and the dashboard. Use tabs for navigation within the Scenarios module:

- **Accounts** tab (this phase)
- **Net Worth** tab (this phase — historical only)
- **Scenarios** tab (Phase 6+)

### 5a. Accounts tab

Left panel: account list grouped by Asset / Liability. Each row:
- Account name + type badge
- Entity
- Current balance (most recent history entry)
- Last balance recorded date
- Rate (current configured rate)

**Add account** opens account editor drawer.

### 5b. Account editor drawer

Adapts fields based on selected account type. Sections:
1. **Core fields**: name, type dropdown, entity, is_active toggle
2. **Type-specific config**: renders appropriate fields for the selected type (see Section 5.3.4 of scenarios supplemental)
3. **Rate schedule**: "Base rate" field + date-ordered list of rate changes. Add/remove rows. Shows "Rate in effect today: X%."
4. **Balance history**: date-ordered list of recorded balances. Each row: date, amount, source (manual/teller-sync), notes. Add/delete entries inline. Mini sparkline chart of the history.

### 5c. Net Worth tab (historical only)

A read-only visualization of actual recorded balance history.

**Chart** (Recharts):
- X-axis: dates of recorded balance entries (linear or time scale)
- Y-axis: balance value
- One line per account (assets positive, liabilities negative)
- "Total Net Worth" line (assets − liabilities) always present — heavier weight
- Legend with toggle checkboxes per account
- Hover tooltip: all account balances on that date

**"As of today" summary cards:**
- Total Assets: $X
- Total Liabilities: $X
- Net Worth: $X

**Date range filter**: from/to pickers to zoom the chart.

**Account detail view** (click a line or account in the list):
- Full balance history table for that account
- Actual rate vs. configured rate comparison for selectable date range
- Format: "From {date} to {date}: Actual rate 8.3% vs. Configured 7.0%"

---

## Step 6: Pre-seed Jeremy's accounts

Per the reference data in `docs/family-finance-scenarios.md` (Section: "Reference: This Household's Accounts"), create a seed migration `migrations/0011_seed_scenario_accounts.sql` that inserts the expected accounts with placeholder balances:

- Checking / Savings
- Gong 401(k) (Traditional)
- Roth IRA
- Taxable Brokerage
- Gong equity (Private Equity, ISO)
- Ripple stake (Private Equity)
- Whitford House (Real Estate Investment)
- SF Home (Real Estate Primary)
- SF Mortgage (Mortgage, linked to SF Home)
- Whitford House Mortgage
- 529 — Daughter
- 529 — Son
- SS — Jeremy (Social Security)
- SS — Elyse (Social Security)

Balances all set to 0 — Jeremy fills in real values via the UI. This gives him the account structure to populate rather than starting from scratch.

---

## Acceptance Criteria

1. All 13 account types can be created, edited, and archived
2. Type-specific config fields render correctly per type — required fields validated
3. Rate schedule: adding a future-dated rate change is stored and the "rate in effect today" displays correctly
4. Balance history entries: add, edit, delete all work; mini sparkline updates
5. Net worth chart renders from balance history data — total net worth line correct
6. Account detail shows actual rate calculation between any two balance history points
7. Pre-seeded accounts from Jeremy's household appear in the accounts list with $0 balances
8. `scenario_accounts`, `scenarios`, `scenario_snapshots`, and related tables all exist in Neon (even though scenarios aren't built yet)
