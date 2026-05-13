# Module 5: Scenarios — Supplemental Specification
**Parent spec:** Family Financial Management System v0.5
**Module name:** Scenarios (referred to as "Net Worth & Scenarios" in parent spec)
**Status:** Ready for phased build

---

## Purpose

The Scenarios module answers the question: *given everything we know about our assets, liabilities, income, expenses, and taxes — what does our financial future look like, and how do we optimize it?*

It operates on the **balance sheet** (asset and liability values over time), while Modules 3 and 4 operate on **cash flow** (income and expenses). Cash flow from Module 3 plans feeds into this module as a key input, but Scenarios adds the dimensions that cash flow alone can't capture: appreciation, compounding, tax-optimal withdrawal sequencing, and long-range net worth trajectory.

The module is intentionally the most complex in the system. This document breaks the build into seven sequential phases, each independently usable, with full reference context for each computation.

---

## Build Phases Overview

| Phase | Name | What It Delivers | Dependencies |
|-------|------|-----------------|--------------|
| 1 | Account Setup | Configure all balance sheet accounts; no engine yet | None (standalone) |
| 2 | Historical View | Display actual recorded balance trajectory and net worth | Phase 1 |
| 3 | Tax & Profile Configuration | User profile, tax brackets, deductions — all inputs the engine needs | None (standalone) |
| 4 | Basic Projection Engine | Single-pass forward projection: cash flow + account growth + basic allocation + flags | Phases 1, 2, 3; Module 3 plans |
| 5 | Full Tax Engine | AMT, NIIT, QBI, depreciation recapture, SS, 529 withdrawals layered in | Phase 4 |
| 6 | Two-Pass Optimization | Allocation optimization, Roth conversion proposals, Pass 2 recalculation | Phase 5 |
| 7 | Scenario Management | Async jobs, snapshots, side-by-side comparison, stale detection | Phase 6 |

Each phase produces a runnable, useful system. Phases 1–2 are immediately usable for balance sheet tracking even before any projection engine exists.

---

## Phase 1: Account Setup

### What Gets Built
A configuration UI where the user defines every balance sheet account — assets and liabilities — that will participate in projections. No calculations happen here; this is purely data entry and management.

### Screens
**Account List** — grid showing all configured accounts with: name, type, asset/liability, current balance, last balance update, entity. Actions: Add, Edit, Archive.

**Account Editor** — form for creating or editing an account. Fields vary by account type (see Reference section below). Core fields present on all types:
- Name
- Account type (dropdown)
- Asset or Liability (auto-set by type, shown explicitly)
- Entity (Personal / Whitford House / Elyse Coaching / etc.)
- Current balance / value
- Notes

**Rate Schedule Editor** — sub-component within Account Editor. Used by all account types that have a rate of return or interest rate. Interface: a base rate field + a date-ordered list of `{effective_date, new_rate}` rows. Add/remove rows. Preview: "Rate in effect on [date] = X%."

**Balance History Log** — sub-component within Account Editor. A date-ordered list of manually recorded balances. Each entry: `{date, balance, source (manual / teller-sync), notes}`. Add/edit/delete. Chart preview of the recorded history.

### Technical Approach
- All account data stored in D1
- Account types are an enum; type determines which additional fields are shown in the editor
- Rate schedules stored as a separate table keyed to account (same pattern as `plan_category_changes`)
- Balance history is a simple time-series table; no computation at this phase
- Teller account linking: optional field — if set, a sync job can pull current balance into the history log automatically (but this is not the transaction sync from Module 1; it's just a balance snapshot)

### Data Model
```sql
CREATE TABLE scenario_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,           -- enum: checking, brokerage, trad_401k, roth_ira, real_estate_primary,
                                --   real_estate_investment, mortgage, heloc, loan, private_equity,
                                --   529, social_security, other_asset, other_liability
  asset_or_liability TEXT NOT NULL,  -- 'asset' | 'liability'
  entity_id TEXT REFERENCES entities(id),
  current_balance REAL,
  teller_account_id TEXT,       -- optional link to Gather module account
  is_active INTEGER DEFAULT 1,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE account_type_config (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES scenario_accounts(id),
  config_json TEXT NOT NULL     -- type-specific fields stored as JSON (see type configs below)
);

CREATE TABLE account_rate_schedule (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES scenario_accounts(id),
  base_rate REAL NOT NULL,      -- annual percentage (e.g., 0.07 = 7%)
  effective_date TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE account_balance_history (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES scenario_accounts(id),
  balance REAL NOT NULL,
  recorded_date TEXT NOT NULL,
  source TEXT DEFAULT 'manual', -- 'manual' | 'teller_sync'
  notes TEXT
);
```

### Type-Specific Config JSON Schemas

**Real Estate (primary or investment):**
```json
{
  "purchase_price": 850000,
  "purchase_date": "2019-06-01",
  "is_primary_residence": true,
  "accumulated_depreciation": 0,
  "tax_lots": []
}
```

**Investment / Brokerage:**
```json
{
  "tax_lots": [
    { "acquisition_date": "2020-03-15", "cost_basis": 45000, "current_value_pct": 0.30 }
  ]
}
```

**Retirement (Traditional 401k / IRA / Roth):**
```json
{
  "owner": "jeremy",            -- "jeremy" | "elyse"
  "account_subtype": "traditional_401k",
  "roth_contribution_basis": 0, -- for Roth: total contributions (not earnings), no tax/penalty on withdrawal
  "annual_contribution": 23000  -- current year contribution (overridden by plan if linked)
}
```

**Mortgage:**
```json
{
  "original_principal": 420000,
  "origination_date": "2019-06-01",
  "term_months": 360,
  "current_principal": 387000,
  "monthly_payment": 2250,
  "payment_override": null      -- if set, overrides calculated payment
}
```

**529:**
```json
{
  "owner": "jeremy",
  "beneficiary": "daughter",    -- "daughter" | "son"
  "annual_contribution": 10000,
  "withdrawal_schedule": [
    { "start_year": 2027, "annual_amount": 35000, "duration_years": 4, "qualified": true }
  ]
}
```

**Social Security:**
```json
{
  "person": "jeremy",
  "fra_monthly_benefit": 3200,  -- from SSA estimate at full retirement age
  "full_retirement_age": 67,
  "elected_start_age": 67
}
```

**Private Equity:**
```json
{
  "company": "Gong",
  "shares_or_units": 50000,
  "current_estimated_value": 1500000,
  "cost_basis_per_share": 1.25,
  "grant_type": "ISO",          -- "ISO" | "NSO" | "RSU" | "common"
  "vesting_schedule": [
    { "date": "2025-01-01", "units": 12500 }
  ],
  "liquidity_events": [
    { "date": "2027-01-01", "type": "IPO", "estimated_price_per_share": 45 }
  ]
}
```

### Acceptance Criteria
- User can create, edit, and archive all account types
- Rate schedule editor works for all rate-bearing accounts
- Balance history can be manually entered and displays as a simple chart
- All data persists correctly in D1

---

## Phase 2: Historical Balance View

### What Gets Built
Visualization of actual recorded account balance history — net worth over time from recorded data, before any projection is added. This is the "left half" of the eventual scenario chart.

### Screens
**Net Worth Dashboard** (read-only at this phase)
- Line chart: one line per account, toggled on/off from a legend
- "Total Net Worth" line (assets minus liabilities) always present
- X-axis: dates of recorded balance entries
- Y-axis: balance value
- Assets positive, liabilities displayed as negative values in the same scale
- Tooltip on hover: shows all account balances on that date
- Date range filter: from/to
- "As of today" summary cards: total assets, total liabilities, net worth

**Account Detail View**
- Single-account chart of balance over time
- Table of all balance history entries for the account
- Calculated: actual rate of return between any two logged dates vs. configured rate
  - Formula: `actual_rate = (ending_balance / beginning_balance) ^ (1 / years) - 1`
  - Comparison: "Configured 7.0% — Actual 8.3% over this period"

### Technical Approach
- Pure read from `account_balance_history`; no projection engine yet
- Net worth on any date = sum of asset balances logged on or before that date (most recent entry per account) minus sum of liability balances
- Interpolation: if an account has no entry for a given date range, the chart can interpolate linearly between known points (clearly labeled as estimated) or show gaps
- Chart library: recharts (already in the React stack)

### Acceptance Criteria
- Net worth chart renders from recorded balance history
- Per-account toggle works
- Account detail shows actual vs. configured rate comparison
- Date range filter works correctly

---

## Phase 3: Tax & Profile Configuration

### What Gets Built
All the configuration inputs the projection engine will need for tax calculations. Built as a standalone settings section — no engine yet, but this data must be in place before Phase 4 runs.

### Screens

**User Profile**
- Person records: Name, Date of Birth, relationship (spouse/self)
- Filing status: Married Filing Jointly (default), Single, etc.
- Expected retirement date (per person)
- State of residence timeline: `{state, effective_date}` ordered list (e.g., CA through 2027-06, then VT)

**Federal Tax Bracket Configuration**
- Pre-loaded with current year brackets (MFJ and Single)
- User can add/edit future-year bracket assumptions (e.g., "assume 2026 TCJA sunset — revert to pre-2018 brackets")
- Option to apply annual inflation adjustment to brackets (e.g., +2.5%/year for bracket creep)
- Brackets stored as: `{year, filing_status, brackets: [{floor, ceiling, rate}], standard_deduction}`

**State Tax Configuration**
- Pre-loaded for California and Vermont
- California: progressive brackets, 1% SDI, standard deduction
- Vermont: progressive brackets, standard deduction
- User can add other states
- Each state config: `{state, year, brackets or flat_rate, standard_deduction}`

**Deductions Configuration**
- Standard deduction: auto-populated from federal brackets table
- Itemized deductions (user-configures annual amounts):
  - Mortgage interest: auto-calculated from mortgage account amortization schedule (if account exists)
  - State and local taxes (SALT): capped at $10,000 under current law (user can adjust cap assumption)
  - Charitable donations: user-entered annual amount
  - Other: free-form line items with amount and description
- System will select greater of standard vs. itemized each year (or user can force one)

**Capital Gains Configuration**
- LTCG rate thresholds (pre-loaded: 0% / 15% / 20% by income bracket for MFJ)
- NIIT threshold (pre-loaded: $250K MAGI for MFJ)
- State capital gains treatment per state (CA: taxed as ordinary income; VT: taxed as ordinary income)

### Reference: Current Tax Law (2025, MFJ)

**Federal Ordinary Income Brackets (2025 MFJ):**
| Rate | Income From | Income To |
|------|------------|-----------|
| 10% | $0 | $23,200 |
| 12% | $23,200 | $94,300 |
| 22% | $94,300 | $201,050 |
| 24% | $201,050 | $383,900 |
| 32% | $383,900 | $487,450 |
| 35% | $487,450 | $731,200 |
| 37% | $731,200+ | — |

Standard deduction (2025 MFJ): $29,200

**LTCG Rates (2025 MFJ):**
| Rate | Taxable Income Threshold |
|------|------------------------|
| 0% | Up to $94,050 |
| 15% | $94,050 – $583,750 |
| 20% | Above $583,750 |

NIIT (Net Investment Income Tax): 3.8% on lesser of net investment income or amount by which MAGI exceeds $250,000 (MFJ)

**AMT (2025 MFJ):**
- Exemption: $137,000
- Exemption phaseout: begins at $1,237,450 AMTI
- AMT rate: 26% up to $232,600 AMTI; 28% above
- Key AMT add-back items: ISO spread at exercise, state income tax deduction (SALT), miscellaneous deductions

**QBI Deduction (§199A):**
- 20% deduction on qualified business income from pass-through entities
- For income above threshold ($383,900 MFJ in 2025): limited to greater of 50% of W-2 wages OR 25% of W-2 wages + 2.5% of qualified property
- Coaching businesses (Elyse): likely classified as Specified Service Trade or Business (SSTB) — QBI deduction phases out completely above $483,900 MFJ income

**California State Tax (2025 MFJ):**
| Rate | Income From | Income To |
|------|------------|-----------|
| 1% | $0 | $20,824 |
| 2% | $20,824 | $49,368 |
| 4% | $49,368 | $77,918 |
| 6% | $77,918 | $108,162 |
| 8% | $108,162 | $136,700 |
| 9.3% | $136,700 | $698,274 |
| 10.3% | $698,274 | $837,922 |
| 11.3% | $837,922 | $1,000,000 |
| 12.3% | $1,000,000+ | — |
| +1% Mental Health | $1,000,000+ | — |

CA SDI: 1.1% (no wage cap as of 2024)
CA capital gains: taxed as ordinary income (no preferential rate)
CA standard deduction (MFJ): $10,726

**Vermont State Tax (2025 MFJ):**
| Rate | Income From | Income To |
|------|------------|-----------|
| 3.35% | $0 | $72,500 |
| 6.6% | $72,500 | $110,000 |
| 7.6% | $110,000 | $213,150 |
| 8.75% | $213,150+ | — |

VT capital gains: 40% exclusion on gains from assets held >3 years; remainder taxed as ordinary income.
VT standard deduction (MFJ): mirrors federal.

### Technical Approach
- Tax bracket data stored as JSON in D1 (queryable by year + filing status)
- Deduction config stored per-user with effective dates (same pattern as rate schedules)
- No computation at this phase — pure configuration UI
- Pre-loading CA and VT brackets removes a significant manual setup burden

### Data Model
```sql
CREATE TABLE user_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'self',     -- 'self' | 'spouse'
  date_of_birth TEXT NOT NULL,
  expected_retirement_date TEXT
);

CREATE TABLE state_residence_timeline (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  effective_date TEXT NOT NULL  -- this state applies from this date forward
);

CREATE TABLE tax_bracket_schedules (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  filing_status TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,   -- 'federal' | 'CA' | 'VT' | etc.
  brackets_json TEXT NOT NULL,  -- [{floor, ceiling, rate}]
  standard_deduction REAL,
  created_by TEXT DEFAULT 'system'  -- 'system' (pre-loaded) | 'user'
);

CREATE TABLE tax_deduction_config (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- 'salt' | 'charitable' | 'mortgage_interest' | 'other'
  label TEXT,
  annual_amount REAL,
  effective_date TEXT NOT NULL,
  source TEXT DEFAULT 'manual'  -- 'manual' | 'auto_mortgage' (calculated from account)
);

CREATE TABLE capital_gains_config (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  jurisdiction TEXT NOT NULL,
  ltcg_brackets_json TEXT,      -- [{floor, ceiling, rate}]
  niit_rate REAL DEFAULT 0.038,
  niit_threshold REAL DEFAULT 250000,
  stcg_as_ordinary INTEGER DEFAULT 1
);
```

### Acceptance Criteria
- User profile with DOB, filing status, and state timeline saves correctly
- Federal brackets pre-loaded for current year; user can add future-year adjustments
- CA and VT state brackets pre-loaded
- Deduction config captures mortgage interest (auto from account), SALT, charitable
- All configuration is editable and versioned by effective date

---

## Phase 4: Basic Projection Engine

### What Gets Built
A single-pass forward projection: takes today's account balances, applies the selected cash flow plan, grows/amortizes each account at its configured rate, and allocates surpluses and deficits via a simple waterfall. Produces the first runnable scenario with net worth trajectory and basic flags.

Tax calculation at this phase: **ordinary income + LTCG/STCG + state only** (Phase 5 adds AMT, NIIT, QBI). This is intentional — get the engine running first, layer complexity in Phase 5.

### Projection Algorithm (Single-Pass)

The engine runs year-by-year (or month-by-month for the first 24 months). For each period:

```
PERIOD LOOP:
  1. Get cash flow from plan
     - income sources for this period (from Module 3 plan, applying time-based adjustments)
     - expense categories for this period (from Module 3 plan)
     - one-time items falling in this period
     - net_cash_flow_pretax = total_income - total_expenses

  2. Estimate taxes (simplified at Phase 4)
     - ordinary_income = W2_income + business_income + SS_income_taxable_portion
     - capital_gains = realized gains from any forced account draws this period
     - estimated_tax = calculate_ordinary_tax(ordinary_income) + calculate_ltcg_tax(capital_gains)
     - net_cash_flow_aftertax = net_cash_flow_pretax - estimated_tax

  3. Grow all accounts
     For each asset account:
       - period_return = account.balance * (rate / periods_per_year)
       - account.balance += period_return
     For each mortgage/amortizing liability:
       - interest_payment = principal * (rate / 12)
       - principal_payment = monthly_payment - interest_payment
       - account.balance -= principal_payment  (reduce principal owed)

  4. Allocate surplus or cover deficit
     If net_cash_flow_aftertax > 0:
       - Run surplus waterfall (see 4a)
     Else:
       - Run deficit waterfall (see 4b)

  5. Calculate period summary
     - net_worth = sum(asset_balances) - sum(liability_balances)
     - Store period result
     - Evaluate and store any flags
```

### Surplus Allocation Waterfall (4a)
User-configurable ordered list. Default order:
1. **Emergency reserve** — if checking/savings < (monthly_expenses × 6), deposit here first
2. **HSA** — if HSA account exists and contribution limit not reached ($8,300 family 2025), deposit up to limit
3. **401(k) / Roth IRA** — deposit up to annual limit ($23,000 401k / $7,000 IRA, 2025); prefer Roth if current marginal rate < projected future rate
4. **High-interest debt paydown** — if any liability has rate above threshold (default: 6%), pay down principal
5. **Taxable brokerage / savings** — remainder

Look-ahead check: before depositing to a retirement account, look 12 months ahead. If projected deficit requires a draw within that window, keep funds liquid instead. Flag this decision.

### Deficit Draw Waterfall (4b)
User-configurable ordered list. Default order:
1. **Checking / savings** (liquid; no tax consequence)
2. **Taxable brokerage** — draw minimum needed; prefer lots with smallest capital gain; tax impact calculated and added to year's liability
3. **Roth IRA contributions** (basis only; no tax or penalty; confirm basis available)
4. **Traditional IRA / 401(k)** — draw only if no other option; calculate ordinary income tax on full amount; add 10% penalty if owner < 59½; flag this as a penalty withdrawal

### Tax Calculation (Phase 4 — Simplified)

```
FUNCTION calculate_ordinary_tax(income, year, filing_status, state):
  federal_brackets = get_brackets('federal', year, filing_status)
  state_brackets = get_brackets(current_state(year), year, filing_status)

  deductions = max(standard_deduction, itemized_deductions_total(year))
  taxable_income = max(0, income - deductions)

  federal_tax = apply_brackets(taxable_income, federal_brackets)
  state_tax = apply_brackets(taxable_income, state_brackets)

  RETURN federal_tax + state_tax

FUNCTION calculate_ltcg_tax(gains, total_income, year):
  ltcg_brackets = get_ltcg_brackets(year)
  ltcg_tax = apply_brackets(gains, ltcg_brackets, stacked_on=total_income)
  RETURN ltcg_tax

FUNCTION apply_brackets(income, brackets):
  tax = 0
  FOR each bracket in brackets:
    taxable_in_bracket = min(income, bracket.ceiling) - bracket.floor
    IF taxable_in_bracket > 0:
      tax += taxable_in_bracket * bracket.rate
  RETURN tax
```

Note on LTCG bracket stacking: capital gains are taxed at preferential rates, but they "stack on top of" ordinary income for determining which LTCG bracket applies. Implementation must stack correctly.

### Social Security Income (Phase 4)
- SS income begins in the projection year when the person reaches their elected start age
- Monthly benefit is adjusted from FRA benefit:
  - If claiming before FRA (62–66): benefit reduced by 5/9 of 1% per month for first 36 months early, then 5/12 of 1% per month beyond that
  - If claiming after FRA (up to 70): benefit increased by 8% per year (delayed retirement credits)
  - Formula: `adjusted_benefit = fra_benefit * ss_adjustment_factor(elected_age, fra)`
- Taxable portion of SS income (simplified for Phase 4):
  - If combined income (AGI + nontaxable interest + 50% of SS) < $32,000 (MFJ): 0% taxable
  - If combined income $32,000–$44,000: up to 50% taxable
  - If combined income > $44,000: up to 85% taxable
  - Standard assumption at Phase 4: use 85% taxable for any projection year where SS + other income is likely above $44K threshold

### Reference: SS Adjustment Factors
| Claiming Age | Monthly FRA Benefit Adjustment |
|-------------|-------------------------------|
| 62 | −30% (maximum reduction for FRA 67) |
| 63 | −25% |
| 64 | −20% |
| 65 | −13.3% |
| 66 | −6.7% |
| 67 (FRA) | 0% |
| 68 | +8% |
| 69 | +16% |
| 70 | +24% (maximum) |

### Flags Generated at Phase 4
| Flag | Trigger |
|------|---------|
| FUNDING_GAP | Liquid account balance projected negative |
| PENALTY_WITHDRAWAL | Retirement draw triggered before age 59½ |
| LOW_LIQUIDITY | Liquid balance < 3 months planned expenses |
| RMD_DUE | Owner reaches age 73 (Traditional IRA/401k only) |
| MORTGAGE_PAYOFF | Mortgage principal reaches $0 |
| SS_BEGINS | SS income starts for a person |

### RMD Calculation (for RMD_DUE flag)
When a retirement account owner turns 73, Required Minimum Distributions must begin:
```
RMD = account_balance_as_of_dec31_prior_year / life_expectancy_factor

Life expectancy factors (IRS Uniform Lifetime Table, selected ages):
Age 73: 26.5
Age 74: 25.5
Age 75: 24.6
Age 76: 23.7
Age 77: 22.9
Age 78: 22.0
Age 79: 21.1
Age 80: 20.2
```
RMD amount is treated as ordinary income in the year taken. It must be taken regardless of whether cash flow needs it.

### Data Model Additions
```sql
CREATE TABLE scenarios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  plan_id TEXT REFERENCES plans(id),
  account_ids_json TEXT,        -- list of scenario_account IDs included
  allocation_rules_json TEXT,   -- ordered surplus + deficit waterfalls
  status TEXT DEFAULT 'draft',  -- 'draft' | 'running' | 'complete' | 'failed' | 'stale'
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE scenario_snapshots (
  id TEXT PRIMARY KEY,
  scenario_id TEXT REFERENCES scenarios(id),
  run_at TEXT NOT NULL,
  inputs_json TEXT NOT NULL,    -- full copy of all inputs at time of run
  results_json TEXT NOT NULL,   -- full projection output (year-by-year)
  pass INTEGER DEFAULT 1,       -- 1 = single-pass, 2 = optimized
  status TEXT DEFAULT 'complete'
);

CREATE TABLE scenario_period_results (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT REFERENCES scenario_snapshots(id),
  period_date TEXT NOT NULL,    -- first day of the period (year or month)
  period_type TEXT NOT NULL,    -- 'month' | 'year'
  gross_income REAL,
  total_expenses REAL,
  net_cash_pretax REAL,
  estimated_tax REAL,
  net_cash_aftertax REAL,
  total_asset_value REAL,
  total_liability_value REAL,
  net_worth REAL,
  account_balances_json TEXT    -- {account_id: balance} snapshot
);

CREATE TABLE scenario_flags (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT REFERENCES scenario_snapshots(id),
  period_date TEXT NOT NULL,
  flag_type TEXT NOT NULL,
  description TEXT,
  severity TEXT DEFAULT 'info'  -- 'info' | 'warning' | 'critical'
);

CREATE TABLE allocation_decisions (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT REFERENCES scenario_snapshots(id),
  period_date TEXT NOT NULL,
  decision_type TEXT,           -- 'surplus' | 'deficit' | 'roth_conversion' | 'look_ahead_hold'
  pass1_action TEXT,
  pass2_action TEXT,
  net_worth_impact REAL,
  rationale TEXT,
  flagged_for_review INTEGER DEFAULT 0
);
```

### Async Job Infrastructure
Phase 4 introduces the background job system:
- Cloudflare Worker triggers scenario run as a Durable Object or Queue consumer
- UI polls scenario status via a lightweight endpoint: `GET /api/scenarios/{id}/status`
- Status transitions: `draft → running → complete` (or `failed`)
- When complete, snapshot is written and UI refreshes automatically
- Run time target: < 30 seconds for a 30-year monthly projection on typical account set

### Acceptance Criteria
- User can create a scenario, select a plan and accounts, and run it
- Projection produces year-by-year net worth output
- Surplus/deficit allocation follows configured waterfall
- Basic tax calculation (ordinary + LTCG + state) runs correctly
- All flags listed above are generated when conditions are met
- Async job runs, status is visible, result loads when complete
- Results visible as chart (net worth over time) and annual summary table

---

## Phase 5: Full Tax Engine

### What Gets Built
Layer the remaining tax calculations on top of the Phase 4 engine: AMT, NIIT, QBI deduction, depreciation recapture on real estate, full 529 withdrawal modeling, and accurate SS taxability calculation. The engine architecture doesn't change — Phase 5 upgrades `calculate_tax()`.

### AMT (Alternative Minimum Tax)

Relevant primarily in years with ISO exercise, high SALT deductions, or large miscellaneous deductions.

```
FUNCTION calculate_amt(regular_taxable_income, amt_adjustments, year, filing_status):
  // Step 1: Calculate AMTI
  amti = regular_taxable_income
       + iso_spread_exercised_this_year      // add back ISO bargain element
       + salt_deduction_taken                // add back state tax deduction
       + miscellaneous_deductions_taken      // add back 2% misc deductions

  // Step 2: Apply exemption
  exemption = get_amt_exemption(year, filing_status)  // $137,000 MFJ 2025
  phaseout_floor = get_amt_phaseout(year, filing_status)  // $1,237,450 MFJ 2025
  IF amti > phaseout_floor:
    exemption_reduction = (amti - phaseout_floor) * 0.25
    exemption = max(0, exemption - exemption_reduction)
  amti_after_exemption = max(0, amti - exemption)

  // Step 3: Calculate tentative minimum tax
  IF amti_after_exemption <= 232600:
    tentative_min_tax = amti_after_exemption * 0.26
  ELSE:
    tentative_min_tax = (232600 * 0.26) + ((amti_after_exemption - 232600) * 0.28)

  // Step 4: AMT owed = excess over regular tax
  regular_tax = calculate_regular_federal_tax(regular_taxable_income)
  amt_owed = max(0, tentative_min_tax - regular_tax)

  RETURN amt_owed
```

**When AMT is triggered in this household:**
- ISO exercise years (Gong IPO scenario): the bargain element (FMV at exercise minus strike price) is an AMT preference item, even if the shares are not sold
- High SALT years (while in California): CA state tax deduction is an AMT add-back

### NIIT (Net Investment Income Tax)

```
FUNCTION calculate_niit(net_investment_income, magi, year, filing_status):
  threshold = 250000  // MFJ 2025
  niit_rate = 0.038

  IF magi <= threshold:
    RETURN 0

  niit_base = min(net_investment_income, magi - threshold)
  RETURN niit_base * niit_rate

// Net investment income includes:
//   - dividends, interest, capital gains from brokerage
//   - rental income (Whitford House net income)
//   - passive income
// Does NOT include:
//   - W-2 wages
//   - active business income (coaching)
//   - distributions from retirement accounts
```

**Key consideration for this household:** Whitford House rental income is net investment income. In years with significant rental income plus capital gains, NIIT exposure is meaningful.

### QBI Deduction (§199A)

```
FUNCTION calculate_qbi_deduction(qbi_by_entity, total_taxable_income, w2_wages_by_entity, year):
  threshold_lower = 383900  // MFJ 2025
  threshold_upper = 483900  // MFJ 2025 (threshold_lower + $100K)

  total_qbi_deduction = 0

  FOR each business_entity in [elyse_coaching, jeremy_consulting]:
    entity_qbi = qbi_by_entity[entity]
    tentative_deduction = entity_qbi * 0.20

    IF total_taxable_income <= threshold_lower:
      // Below threshold: full 20% deduction
      entity_deduction = tentative_deduction

    ELSE IF total_taxable_income >= threshold_upper:
      // Above upper threshold: SSTB is fully phased out
      // Coaching businesses are almost certainly SSTB (health, law, accounting, consulting, financial)
      entity_deduction = 0

    ELSE:
      // Phase-in range: deduction phases out proportionally
      phase_out_pct = (total_taxable_income - threshold_lower) / 100000
      entity_deduction = tentative_deduction * (1 - phase_out_pct)

    total_qbi_deduction += entity_deduction

  RETURN min(total_qbi_deduction, total_taxable_income * 0.20)
```

**Important note:** Elyse's coaching business is likely a Specified Service Trade or Business (SSTB) — the IRS classifies consulting, health, and financial services as SSTB. QBI deduction fully phases out above the upper threshold. In years where combined income exceeds ~$484K, no QBI deduction applies.

### Depreciation Recapture (Whitford House — Investment Real Estate)

When investment real estate is sold, depreciation previously taken is "recaptured" and taxed at a maximum 25% rate:

```
FUNCTION calculate_depreciation_recapture(sale_price, purchase_price, accumulated_depreciation):
  // Adjusted basis = purchase_price - accumulated_depreciation
  adjusted_basis = purchase_price - accumulated_depreciation

  // Total gain
  total_gain = sale_price - adjusted_basis

  // Recapture portion (taxed at 25% max)
  recapture_gain = min(accumulated_depreciation, total_gain)
  recapture_tax = recapture_gain * 0.25

  // Remaining gain (taxed at LTCG rates)
  section_1231_gain = total_gain - recapture_gain
  ltcg_tax = calculate_ltcg_tax(section_1231_gain, ...)

  RETURN { recapture_tax, ltcg_tax, total_tax: recapture_tax + ltcg_tax }

// Annual depreciation on Whitford House (residential rental):
//   Depreciable basis = purchase_price - land_value (typically 20-30% of purchase price)
//   Recovery period = 27.5 years (residential)
//   Annual depreciation = depreciable_basis / 27.5
//   This accumulates in account_type_config.accumulated_depreciation
```

### 529 Withdrawal Modeling

```
FUNCTION calculate_529_withdrawal(account, year, withdrawal_amount):
  // Qualified expenses: tuition, fees, books, room & board
  current_balance = account.balance
  contribution_basis = account.total_contributions  // tracked separately
  earnings = current_balance - contribution_basis

  IF withdrawal.qualified:
    // No tax, no penalty
    tax = 0
    penalty = 0
  ELSE:
    // Non-qualified: earnings portion is taxable + 10% penalty
    earnings_pct = earnings / current_balance
    taxable_earnings = withdrawal_amount * earnings_pct
    tax = calculate_ordinary_tax(taxable_earnings, ...)
    penalty = taxable_earnings * 0.10

  account.balance -= withdrawal_amount
  RETURN { tax, penalty }
```

Withdrawal schedule is configured on the account (see Phase 1 config). Engine processes these automatically in the relevant years.

### Accurate SS Taxability

Phase 5 replaces the Phase 4 85%-always assumption with the correct calculation:

```
FUNCTION calculate_ss_taxable_income(ss_gross, other_agi, tax_exempt_interest):
  combined_income = other_agi + tax_exempt_interest + (ss_gross * 0.50)

  IF combined_income < 32000:      // MFJ thresholds
    taxable_pct = 0.0
  ELSE IF combined_income < 44000:
    taxable_pct = min(0.50, (combined_income - 32000) * 0.50 / 12000)
  ELSE:
    base = min(ss_gross * 0.50, (44000 - 32000) * 0.50)
    additional = min(ss_gross * 0.35, (combined_income - 44000) * 0.85)
    taxable_amount = base + additional
    taxable_pct = taxable_amount / ss_gross

  RETURN ss_gross * taxable_pct
```

### Updated Tax Function (Phase 5 Complete)
```
FUNCTION calculate_tax_year(year_inputs):
  // year_inputs: {ordinary_income, capital_gains_lt, capital_gains_st,
  //               qbi_by_entity, w2_wages, iso_exercised,
  //               rental_income_net, ss_gross, year, filing_status}

  ss_taxable = calculate_ss_taxable_income(ss_gross, ...)
  total_ordinary = ordinary_income + capital_gains_st + ss_taxable

  qbi_deduction = calculate_qbi_deduction(qbi_by_entity, total_ordinary, w2_wages, year)
  deductions = max(standard_deduction, itemized_total) + qbi_deduction
  taxable_income = max(0, total_ordinary - deductions)

  federal_ordinary_tax = apply_brackets(taxable_income, federal_brackets)
  ltcg_tax = calculate_ltcg_tax(capital_gains_lt, taxable_income)

  net_investment_income = capital_gains_lt + capital_gains_st + rental_income_net
  magi = total_ordinary + capital_gains_lt
  niit = calculate_niit(net_investment_income, magi, year, filing_status)

  amt = calculate_amt(taxable_income, {iso_exercised, salt_taken}, year, filing_status)

  state_tax = calculate_state_tax(total_ordinary, year)

  total_federal = federal_ordinary_tax + ltcg_tax + niit + amt
  RETURN { total_federal, state_tax, total: total_federal + state_tax, breakdown: {...} }
```

### Acceptance Criteria
- AMT calculated correctly in ISO exercise scenarios
- NIIT triggers at correct MAGI threshold
- QBI deduction phases out correctly for coaching income above $483K
- Depreciation recapture calculated on Whitford House sale event
- 529 withdrawals processed in correct years; qualified vs. non-qualified distinction works
- SS taxability calculated using correct combined income formula
- Year-over-year tax estimates are materially more accurate than Phase 4

---

## Phase 6: Two-Pass Optimization + Roth Conversions

### What Gets Built
A second pass over the Phase 4/5 projection that revisits flagged allocation decisions, models alternatives, selects better outcomes, and specifically evaluates Roth conversion opportunities in low-income years.

### Pass 2 Algorithm

```
PASS 2 ALGORITHM:
  1. Run Pass 1 (full Phase 5 engine) — collect all flagged decisions
  2. Group flagged decisions by type
  3. For each ALLOCATION decision (surplus or deficit):
     - Model 2-3 alternatives (different account choices)
     - For each alternative: re-project forward from that decision point through end date
     - Compare end-state net worth for each alternative
     - Select highest net worth outcome
     - If alternatives within 2% of each other: flag as ambiguous, present both to user
  4. Evaluate ROTH CONVERSION opportunities (see below)
  5. Re-run full projection incorporating all Pass 2 decisions
  6. Store both Pass 1 and Pass 2 snapshots for comparison
```

### Roth Conversion Evaluation

Run after Pass 1 projection is complete. For each projection year:

```
FUNCTION evaluate_roth_conversion(year, projection):
  current_marginal_rate = get_marginal_rate(year)
  projected_rmd_rate = estimate_marginal_rate_at_rmd(projection)
  // estimate rate at RMD age based on projected income from SS + plan + RMD amounts

  IF current_marginal_rate >= projected_rmd_rate:
    RETURN null  // no benefit to converting now

  // Find optimal conversion amount: fill current bracket without crossing into next
  current_bracket_ceiling = get_current_bracket_ceiling(year)
  current_taxable_income = projection.year_results[year].taxable_income
  conversion_headroom = current_bracket_ceiling - current_taxable_income
  conversion_amount = min(conversion_headroom, traditional_ira_balance * 0.30)
  // cap at 30% of balance to avoid aggressive depletion

  // Calculate NPV of tax savings
  tax_cost_now = conversion_amount * current_marginal_rate
  tax_saved_at_rmd = estimate_future_tax_savings(conversion_amount, projected_rmd_rate)
  npv_savings = pv(tax_saved_at_rmd, years_to_rmd, discount_rate=0.05)

  IF npv_savings > tax_cost_now:
    RETURN {
      year,
      conversion_amount,
      tax_cost_now,
      npv_savings,
      net_benefit: npv_savings - tax_cost_now,
      rationale: "Converting $X at {current_marginal_rate}% saves estimated $Y at RMD age when rate is projected at {projected_rmd_rate}%"
    }
```

**Key years to evaluate for this household:**
- Post-Gong transition years (sabbatical / rest phase): income likely low before consulting/coaching ramps up — strong Roth conversion window
- Post-California pre-Vermont SS years: if SS not yet started, low ordinary income window
- Any year where Whitford House transitions from cost center to profitable — check timing

### Optimization Output Panel

After Pass 2 completes, the UI shows:

1. **Net Worth Impact Summary**
   - "Pass 2 optimization improved projected net worth by $X at end of period"
   - Breakdown: how much came from reallocation vs. Roth conversions

2. **Allocation Changes** — table of decisions that changed from Pass 1 to Pass 2
   - Period, decision type, Pass 1 action, Pass 2 action, rationale

3. **Roth Conversion Recommendations** — for each proposed conversion:
   - Year, recommended amount, tax cost now, NPV of savings, net benefit
   - User can accept, modify amount, or reject each individually
   - Accepted conversions are logged as one-time items in the scenario

4. **Ambiguous Decisions** — decisions where alternatives were within 2% of each other
   - Presented as "this could go either way" with both options and their trade-offs

### Acceptance Criteria
- Pass 2 runs after Pass 1 without requiring user interaction
- Allocation improvements produce demonstrably higher end-state net worth than Pass 1
- Roth conversion proposals appear only in years where NPV benefit is positive
- User can accept/reject each Roth conversion recommendation individually
- Both Pass 1 and Pass 2 snapshots are stored and can be compared side-by-side
- Optimization summary panel clearly shows what changed and why

---

## Phase 7: Scenario Management, Snapshots & Comparison

### What Gets Built
Full scenario lifecycle: creation, configuration, async running, snapshot storage, rerunning, stale detection, and side-by-side comparison between any two snapshots.

### Scenario Lifecycle

```
STATES:
  draft       → configured but never run
  running     → async job in progress
  complete    → latest snapshot available
  stale       → complete, but underlying data has changed since last run
  failed      → last run encountered an error

TRANSITIONS:
  draft       → running    (user clicks Run)
  running     → complete   (job finishes successfully)
  running     → failed     (job encounters error)
  complete    → running    (user re-runs)
  complete    → stale      (plan modified, account balance updated, tax config changed)
  stale       → running    (user re-runs)
```

**Stale detection triggers:**
- The linked Module 3 plan is modified
- Any account balance history entry is added or edited
- Tax bracket configuration is changed
- User profile (DOB, state timeline, retirement date) is changed
- Any account configuration changes (rate schedule, type-specific config)

### Scenario List UI

Main landing page. Per scenario:
- Name, type badge (e.g., "Base," "Solar Install Scenario," "Gong IPO @ $45")
- Date range (e.g., "2026–2060")
- Last run: timestamp + "Stale" badge if applicable
- End-state net worth from last run
- Plan used
- Status indicator
- Actions: View, Edit, Re-run, Duplicate, Compare, Archive

### Scenario Comparison

Select any two snapshots (same or different scenarios) and view:

**Comparison Chart:**
- Both net worth trajectories on the same chart
- Scenario A: solid line; Scenario B: dashed line
- Same past/future shading as single-scenario view
- Legend clearly labels each line

**Comparison Table:**
- Rows: projection years
- Columns per year: Net Worth (A), Net Worth (B), Δ (B minus A)
- Highlighted rows where the delta crosses a threshold (e.g., diverges by > $50K)
- Summary row: end-state net worth A, end-state net worth B, total difference

**Key Divergence Points:**
Automatic identification of the first year where the scenarios diverge significantly, with a note on what drives the difference (e.g., "Solar installation in 2026 creates $35K expense but reduces utility costs from 2027 onward").

### Async Job Infrastructure (Cloudflare)

```
ARCHITECTURE:
  - Cloudflare Queue: scenario run requests published here
  - Worker (consumer): reads from queue, runs projection, writes results
  - D1: stores scenario status + snapshot data
  - UI: polls GET /api/scenarios/{id}/status every 5 seconds while running

JOB RECORD:
  CREATE TABLE scenario_jobs (
    id TEXT PRIMARY KEY,
    scenario_id TEXT REFERENCES scenarios(id),
    queued_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    status TEXT,              -- 'queued' | 'running' | 'complete' | 'failed'
    error_message TEXT,
    worker_instance TEXT
  );

PROGRESS UPDATES (optional for long runs):
  Worker writes progress notes to job record during run:
  - "Projecting years 2026–2030..."
  - "Running Pass 2 optimization..."
  UI displays current progress note while status is 'running'.
```

### Acceptance Criteria
- Scenario list shows all scenarios with correct status badges
- Stale detection fires correctly when any linked data changes
- Comparison view renders correctly for any two snapshots
- Async job system works reliably; failed jobs show error message and allow retry
- Duplicate scenario creates a full copy with "Copy of..." name, inheriting all config

---

## Reference: This Household's Accounts

Pre-populated context for Claude Code to use as realistic test data and to inform which account types / edge cases to prioritize.

### Expected Accounts at Launch

| Account | Type | Asset/Liability | Notes |
|---------|------|----------------|-------|
| Checking (primary) | Checking/Savings | Asset | Liquid operating account |
| Savings | Checking/Savings | Asset | Emergency reserve |
| Gong 401(k) | Traditional 401(k) | Asset | Jeremy; pre-tax; vesting complete at separation |
| Roth IRA | Roth IRA | Asset | Jeremy; post-tax contributions tracked |
| Taxable Brokerage | Taxable Brokerage | Asset | Mixed lots; some LTCG |
| Gong equity | Private Equity | Asset | ISO grants; strike price ~$1.25; IPO scenario key |
| Ripple/XRP stake | Private Equity | Asset | Separate from XRP token; shareholder equity |
| Whitford House | Real Estate (Investment) | Asset | 912 Grandey Rd, Addison VT; purchase ~2019; rental income |
| SF Home | Real Estate (Primary) | Asset | Sunnyside, SF; §121 exclusion eligible |
| SF Mortgage | Mortgage | Liability | On SF home |
| Whitford House Mortgage | Mortgage | Liability | On Whitford House |
| 529 — Daughter | 529 | Asset | Beneficiary: daughter (HS sophomore, ~2027 college start) |
| 529 — Son | 529 | Asset | Beneficiary: son (7th grade, ~2030 college start) |
| SS — Jeremy | Social Security | Income Source | FRA benefit TBD; expected start age TBD |
| SS — Elyse | Social Security | Income Source | FRA benefit TBD |

### Key Scenario Triggers to Model

1. **Gong IPO / Liquidity Event** — ISO exercise triggers AMT; sale triggers LTCG; likely single-year income spike with meaningful tax planning window before and after
2. **California → Vermont Relocation** (~mid-2027) — state tax change from CA (9.3%+ marginal) to VT (7.6% marginal); also affects NIIT calculation (CA taxes investment income as ordinary)
3. **Ripple tender offer / acquisition** — similar to Gong; equity structure is different (not ISOs); tax treatment depends on structure
4. **Whitford House transition** — currently in build-out / renovation phase; depreciation begins accruing; sale scenario should model recapture correctly
5. **SF home sale** — before Vermont relocation; §121 exclusion eligibility; timing relative to relocation matters for exclusion qualification (must be primary residence 2 of last 5 years)
6. **Post-Gong sabbatical / rest phase** — significant income dip; primary Roth conversion window; no W-2 income, some business income
7. **Elyse coaching income ramp** — QBI deduction eligible if income below SSTB threshold; plan scenarios around income levels
8. **Children's college years** — daughter ~2027–2031; son ~2030–2034; 529 withdrawal sequencing; possible overlap year (both in college ~2030)
9. **RMD onset** (Jeremy + Elyse ~2053+) — far-horizon flag; relevant for 30-40 year scenarios

---

*Database infrastructure decision documented separately following dedicated discussion. Decision: Neon (serverless Postgres) via Cloudflare Hyperdrive. See main spec Appendix C for rationale.*

As flagged, the choice of D1/SQLite for this module warrants a dedicated conversation before build starts. Key areas to evaluate:

1. **Recursive CTE for plan inheritance** (Module 3) — SQLite supports recursive CTEs since version 3.8.3; D1 uses SQLite 3.x, so this should work, but needs verification against D1's specific version
2. **JSON operations** — The projection engine stores many intermediate results as JSON blobs. D1 supports `json_extract()` and basic JSON functions; complex JSON aggregation may require application-layer processing
3. **Write throughput for scenario runs** — A 40-year monthly projection with 12 accounts writes ~480 period results + flags + allocation decisions in a single job. D1's write limits (especially in Workers) need evaluation
4. **Transaction support** — The scenario run must be atomic (either fully written or not). D1 supports transactions via `db.batch()`
5. **Query complexity** — The comparison view joins scenario_period_results across two snapshots with per-year deltas. This is achievable in SQLite but benefits from careful indexing

**Recommendation to discuss:** Whether the scenario engine's intermediate state (the period-by-period projection loop) should run entirely in memory within a Worker, writing only the final results to D1, rather than writing each period incrementally. This would reduce write pressure significantly and simplify the transaction model.
