# Build Prompt — Phase 7: Scenarios — Full Tax Engine, Two-Pass Optimization & Scenario Management

**Session goal:** Complete Module 5 (Scenarios) by adding the full tax engine (AMT, NIIT, QBI, depreciation recapture), two-pass allocation optimization, Roth conversion proposals, scenario snapshot comparison, and stale detection. This is the final phase of the system.

**Before writing any code:** Read `apps/cfo/CLAUDE.md`. Read Phases 5 and 6 of `docs/family-finance-scenarios.md` — the complete tax functions (AMT, NIIT, QBI, depreciation recapture), the two-pass algorithm, and the Roth conversion evaluation logic are all specified there with pseudocode.

**Phase 6 (Single-pass engine) must be complete and producing correct results before starting this session.**

---

## What Phase 7 Builds

- Full tax engine: AMT + NIIT + QBI deduction + depreciation recapture layered onto Phase 6's base
- Two-pass optimization: re-evaluates flagged allocation decisions for better net worth outcomes
- Roth conversion proposals: identifies optimal conversion years and amounts
- Scenario comparison: two snapshots side-by-side on chart and table
- Stale detection: scenarios flagged when underlying data changes
- Optimization summary panel: shows what changed between Pass 1 and Pass 2

---

## Step 1: Upgrade the tax engine to full scope

Extend `src/lib/tax-engine.ts` by adding four new functions. The full pseudocode for each is in Phase 5 of `docs/family-finance-scenarios.md`. Implement them exactly as specified.

### 1a. AMT (Alternative Minimum Tax)

```typescript
export function calculateAmt(
  regularTaxableIncome: number,
  isoSpreadExercised: number,     // key for this household (Gong ISOs)
  saltDeductionTaken: number,
  year: number,
  filingStatus: string
): number
```

Key values (2025 MFJ from scenarios supplemental):
- Exemption: $137,000
- Phaseout floor: $1,237,450
- AMT rate: 26% up to $232,600 AMTI, 28% above
- ISO spread is the primary AMT trigger for this household — must be handled correctly

### 1b. NIIT (Net Investment Income Tax)

```typescript
export function calculateNiit(
  netInvestmentIncome: number,    // capital gains + rental income + dividends
  magi: number,
  year: number,
  filingStatus: string
): number
// Threshold: $250,000 MFJ. Rate: 3.8%.
// Whitford House rental income IS net investment income.
```

### 1c. QBI Deduction (§199A)

```typescript
export function calculateQbiDeduction(
  qbiByEntity: Record<string, number>,  // {elyse_coaching: X, jeremy_coaching: Y}
  totalTaxableIncome: number,
  w2WagesByEntity: Record<string, number>,
  year: number
): number
```

Key rules (from scenarios supplemental):
- Both coaching businesses are likely SSTB (Specified Service Trade or Business)
- QBI deduction fully phases out above ~$484K MFJ income (2025)
- Below threshold: 20% of QBI, no limit
- Phase-in range ($384K–$484K): proportional reduction

### 1d. Depreciation Recapture

```typescript
export function calculateDepreciationRecapture(
  salePrice: number,
  purchasePrice: number,
  accumulatedDepreciation: number  // from account_type_config.config_json
): { recaptureTax: number; ltcgTax: number; totalTax: number }
// Recapture rate: 25% (§1250 gain)
// Remaining gain taxed at LTCG rates
// Annual depreciation: depreciable_basis / 27.5 years (residential)
```

### 1e. Update `calculateTax()` signature

Update `TaxYearInputs` to add:
```typescript
iso_spread_exercised: number;    // for AMT
rental_income_net: number;       // Whitford House net (for NIIT)
qbi_by_entity: Record<string, number>;
w2_wages_by_entity: Record<string, number>;
```

Update `calculateTax()` to call all four new functions and include results in `TaxYearResult.breakdown`.

---

## Step 2: Two-pass optimization engine

The projection engine in Phase 6 is a single pass. Phase 7 adds a second pass that revisits flagged allocation decisions.

Extend `src/lib/projection-engine.ts`:

### 2a. Pass 1 — collect flagged decisions

During the existing single-pass run, tag allocation decisions that benefit from look-ahead:
- Surplus deposited to a retirement account when a deficit is projected within 12 months → flag
- Deficit draw from a retirement account before age 59½ → flag
- Surplus deposited to low-yield savings when high-interest debt exists → flag
- Any decision where an alternative allocation would differ in tax treatment → flag

Store flagged decisions in `allocation_decisions` with `flagged_for_review = true`.

### 2b. Pass 2 — evaluate alternatives

```typescript
async function runPass2Optimization(
  db: postgres.Sql,
  snapshotId: string,
  projection: ProjectionResult
): Promise<OptimizationResult>
```

For each flagged decision:
1. Identify 2–3 alternative allocation choices
2. For each alternative: re-project forward from that decision point to end date (partial re-run)
3. Compare end-state net worth for each alternative
4. Select the highest net worth outcome
5. If alternatives within 2% of each other: mark as ambiguous
6. Store Pass 2 choice in `allocation_decisions.pass2_action` + `net_worth_impact` + `rationale`

Re-run the full projection with Pass 2 decisions applied. Store as a second snapshot (pass = 2).

### 2c. Roth conversion proposals

Run after Pass 1 is complete. Implement `evaluateRothConversions()` from the pseudocode in Phase 6 of the scenarios supplemental:

```typescript
async function evaluateRothConversions(
  db: postgres.Sql,
  projection: ProjectionResult,
  profiles: UserProfile[]
): Promise<RothConversionProposal[]>

interface RothConversionProposal {
  year: number;
  conversion_amount: number;
  current_marginal_rate: number;
  projected_rmd_rate: number;
  tax_cost_now: number;
  npv_savings: number;
  net_benefit: number;
  rationale: string;
}
```

Key years to evaluate for this household (from scenarios supplemental):
- Post-Gong sabbatical / rest phase (2026–2027): low W-2 income window
- Post-California, pre-SS years: check income trajectory
- Any year where marginal rate < projected RMD-age rate

Only propose conversions where `npv_savings > tax_cost_now` (positive net benefit).

---

## Step 3: Job orchestration update

Update the Queue consumer in `src/index.ts` to run both passes:

```typescript
async function runAndSaveProjection(env: Env, scenarioId: string, snapshotId: string) {
  // Update job: "Running Pass 1..."
  const pass1Result = await runProjection(params);
  await saveSnapshot(db, snapshotId, pass1Result, pass = 1);

  // Update job: "Running optimization (Pass 2)..."
  const rothProposals = await evaluateRothConversions(db, pass1Result, profiles);
  const pass2Result = await runPass2Optimization(db, snapshotId, pass1Result);
  
  const finalSnapshotId = await saveSnapshot(db, scenarioId, pass2Result, pass = 2, rothProposals);
  
  await markJobComplete(db, snapshotId, finalSnapshotId);
}
```

The UI always shows the Pass 2 snapshot as the primary result. Pass 1 snapshot is accessible for comparison.

---

## Step 4: Optimization summary panel

Add to the results view in `ScenariosView.tsx`:

A collapsible **Optimization Summary** panel below the flags panel:

```
Optimization improved end-state net worth by $X over Pass 1 defaults.

Allocation changes (N decisions changed):
┌─────────────────┬────────────────────────────┬────────────────────────────┬──────────────┐
│ Year            │ Pass 1 Action              │ Pass 2 Action              │ Net Worth Δ  │
├─────────────────┼────────────────────────────┼────────────────────────────┼──────────────┤
│ 2028            │ Deposit to Roth IRA        │ Hold in savings (deficit   │ +$8,400      │
│                 │                            │ projected in 6 months)     │              │
└─────────────────┴────────────────────────────┴────────────────────────────┴──────────────┘

Roth Conversion Proposals (N years):
┌──────┬───────────────┬──────────────────┬──────────────┬──────────────┬───────────────┐
│ Year │ Convert       │ Tax Cost Now     │ NPV Savings  │ Net Benefit  │ Rate Now → RMD│
├──────┼───────────────┼──────────────────┼──────────────┼──────────────┼───────────────┤
│ 2027 │ $45,000       │ $9,900           │ $18,200      │ +$8,300      │ 22% → 32%     │
└──────┴───────────────┴──────────────────┴──────────────┴──────────────┴───────────────┘

Ambiguous decisions (N): [see details →]
```

Roth conversion rows are interactive: Accept / Modify amount / Reject. Accepted conversions are logged as one-time income events in the plan for that year.

---

## Step 5: Scenario comparison

Add a **Compare** action to the scenario list and results view.

### 5a. Snapshot selector

When comparing: pick any two snapshots (same scenario at different times, or two different scenarios). A dropdown per slot shows all available snapshots with timestamps.

### 5b. Comparison chart

Two net worth trajectories on the same chart:
- Scenario A: solid line
- Scenario B: dashed line
- Same past/future shading
- Legend labels each by scenario name + run date

### 5c. Comparison table

| Year | Net Worth (A) | Net Worth (B) | Δ (B − A) |
|---|---|---|---|
Highlighted rows where delta crosses ±$50K.

**Key divergence annotation:** Identify the first year where scenarios diverge by > $25K. Show a note: "Scenarios diverge significantly in {year} — {reason if detectable from flags}."

---

## Step 6: Stale detection

A scenario becomes **Stale** when underlying data changes after the last run. Implement via database triggers or post-write hooks:

Trigger stale when:
- The linked Module 3 plan is modified (`plans.updated_at` changes)
- Any `account_balance_history` row is added/edited for an included account
- Any `account_rate_schedule` row changes for an included account
- `tax_bracket_schedules` or `tax_deduction_config` is modified
- `user_profiles` or `state_residence_timeline` changes

Implementation: after any of these writes, query `scenarios` where the scenario includes the affected plan or account, and set `scenarios.status = 'stale'` where currently `status = 'complete'`.

Show the Stale badge prominently in the scenario list. "Re-run" clears stale status.

---

## Step 7: Sell at date calculator

For real estate and private equity accounts, add a "What would I net if I sold on [date]?" calculator button in the account editor drawer.

```typescript
export function calculateSaleProceeds(
  account: ScenarioAccount,
  saleDate: Date,
  profiles: UserProfile[],
  stateAtDate: string
): SaleCalculation

interface SaleCalculation {
  estimated_market_value: number;   // projected via rate schedule to sale date
  cost_basis: number;
  total_gain: number;
  depreciation_recapture_gain: number;  // real estate investment only
  capital_gain: number;
  estimated_recapture_tax: number;
  estimated_capital_gains_tax: number;
  section_121_exclusion: number;     // primary residence: $500K MFJ if eligible
  estimated_net_proceeds: number;
  assumptions: string[];
}
```

Show as a modal with the calculation breakdown. For the SF home (primary residence), check §121 eligibility (primary residence for 2 of last 5 years).

---

## Acceptance Criteria

1. AMT fires correctly in an ISO exercise scenario: calculate a year with $500K ISO spread and verify AMT exceeds regular tax
2. NIIT fires correctly: verify at a MAGI level above $250K with rental income
3. QBI phases out correctly: verify at income levels below, within, and above the phase-in range
4. Depreciation recapture calculates correctly for a Whitford House sale scenario
5. Pass 2 optimization produces higher end-state net worth than Pass 1 on a scenario with at least one flagged decision
6. At least one Roth conversion is proposed for a year with low projected income
7. Comparison view renders two scenarios on the same chart with correct labeling
8. Stale detection fires within 60 seconds of modifying a linked plan
9. "Sell on date" calculator returns correct net proceeds for both a primary residence (with §121) and investment property (with recapture)
10. A full 40-year scenario with 14 accounts and full tax engine completes within 60 seconds

---

## What's Complete After Phase 7

The full system is built:

- **Gather**: Teller sync + Gmail email enrichment (Amazon, Venmo, Apple, Etsy)
- **Review**: Auto-classification (rules + AI), human approval, bulk actions, learning loop
- **Reporting**: Schedule C/E + summary reports to Google Drive
- **Spending**: Actuals vs. plan with charts, tables, entity filter, category groups
- **Planning**: Foundation + modification plans with inheritance, time adjustments, forecasting
- **Scenarios**: Full balance sheet modeling, tax-optimal projections, two-pass optimization, Roth conversions, 40-year horizons

**Remaining open items before production:**
- Live Gmail validation (`docs/email-samples.md` checklist)
- Teller enrollment (re-enroll accounts in new system)
- Data migration from old CFO (Appendix D.4 of spec)
- OAuth token seeding for Gmail auth (auth route needed)
- User profile DOB fields (Jeremy and Elyse fill in real dates)
- CI workflow `d1_database` input removed before merge to `main`
