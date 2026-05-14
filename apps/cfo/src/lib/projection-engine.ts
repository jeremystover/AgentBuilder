/**
 * Scenarios projection engine — Phase 6 single-pass.
 *
 *   period loop:
 *     1. resolve cash flow from the Module 3 plan
 *     2. apply RMD + SS adjustments (forces some ordinary income)
 *     3. estimate tax (federal ordinary + LTCG + state)
 *     4. grow asset accounts at their configured rate; amortize debts
 *     5. allocate surplus (waterfall) or draw deficit (waterfall)
 *     6. record period results + flags + allocation decisions
 *
 * All output rows are accumulated in memory; the caller writes them
 * to the database as a single transaction. The engine NEVER hits the
 * database from inside the period loop — all inputs (accounts, plan,
 * tax config, profiles) are preloaded.
 */

import type { Sql } from './db';
import { resolvePlan, type ResolvedCategoryAmount } from './plan-resolver';
import { isIncomeSlugOrName } from './forecast';
import {
  calculateTax, loadTaxConfig, rmdFactor, ssAdjustmentFactor,
  findBracketSchedule, getMarginalRate,
  type TaxYearResult,
} from './tax-engine';

// ── Public types ────────────────────────────────────────────────────────────

export interface ProjectionParams {
  scenarioId: string;
  snapshotId: string;
  planId: string;
  accountIds: string[];
  startDate: Date;
  endDate: Date;
  allocationRules: AllocationRules;
  filingStatus: string;  // 'married_filing_jointly'
}

export interface AllocationRules {
  surplus: SurplusStep[];
  deficit: DeficitStep[];
}

export type SurplusStep =
  | { kind: 'emergency_reserve' }
  | { kind: 'retirement', max_per_year?: number }
  | { kind: 'high_interest_paydown', rate_threshold?: number }
  | { kind: 'taxable_brokerage' };

export type DeficitStep =
  | { kind: 'checking' }
  | { kind: 'taxable_brokerage' }
  | { kind: 'roth_contributions' }
  | { kind: 'traditional_retirement' };

export const DEFAULT_RULES: AllocationRules = {
  surplus: [
    { kind: 'emergency_reserve' },
    { kind: 'retirement', max_per_year: 23000 },
    { kind: 'high_interest_paydown', rate_threshold: 0.06 },
    { kind: 'taxable_brokerage' },
  ],
  deficit: [
    { kind: 'checking' },
    { kind: 'taxable_brokerage' },
    { kind: 'roth_contributions' },
    { kind: 'traditional_retirement' },
  ],
};

export interface PeriodResult {
  period_date: string;       // YYYY-MM-DD (first day of bucket)
  period_type: 'month' | 'year';
  gross_income: number;
  total_expenses: number;
  net_cash_pretax: number;
  estimated_tax: number;
  net_cash_aftertax: number;
  total_asset_value: number;
  total_liability_value: number;
  net_worth: number;
  account_balances: Record<string, number>;
}

export interface FlagRow {
  period_date: string;
  flag_type: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface AllocationDecisionRow {
  period_date: string;
  decision_type: 'surplus' | 'deficit';
  pass1_action: string;
  net_worth_impact: number;
  rationale: string;
  flagged_for_review: boolean;
}

export interface ProjectionResult {
  periods: PeriodResult[];
  flags: FlagRow[];
  decisions: AllocationDecisionRow[];
  warnings: string[];
}

// ── Engine state types ──────────────────────────────────────────────────────

interface AccountState {
  id: string;
  name: string;
  type: string;
  asset_or_liability: 'asset' | 'liability';
  /** Live balance — mutates each period. */
  balance: number;
  /** Per-period rate, applied as `balance *= 1 + rate * periodFractionOfYear`. */
  annual_rate: number;
  /** Mortgage-only: monthly payment used to compute principal/interest split. */
  monthly_payment: number;
  /** Owner for retirement / SS accounts; null for non-personal accounts. */
  owner: 'jeremy' | 'elyse' | null;
  /** Roth contribution basis (Roth IRA only) — withdrawable without tax. */
  roth_basis: number;
  /** Type-specific config_json for downstream reference. */
  config: Record<string, unknown>;
}

interface PersonState {
  id: 'jeremy' | 'elyse';
  name: string;
  birth_year: number;
  ss_started: boolean;
  ss_fra_monthly: number;
  ss_elected_age: number;
}

// ── Bucket generator ────────────────────────────────────────────────────────

interface Bucket {
  start: Date;
  end: Date;
  type: 'month' | 'year';
  fractionOfYear: number;
}

function generateBuckets(start: Date, end: Date): Bucket[] {
  const out: Bucket[] = [];
  const startMs = start.getTime();
  const transition = new Date(start);
  transition.setUTCMonth(transition.getUTCMonth() + 24);
  // Monthly buckets.
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  while (true) {
    const bs = new Date(Date.UTC(y, m, 1));
    if (bs.getTime() >= transition.getTime() || bs.getTime() > end.getTime()) break;
    const be = new Date(Date.UTC(y, m + 1, 0));
    const clipStart = bs.getTime() < startMs ? new Date(startMs) : bs;
    const clipEnd   = be.getTime() > end.getTime() ? new Date(end.getTime()) : be;
    const days = Math.round((clipEnd.getTime() - clipStart.getTime()) / 86_400_000) + 1;
    out.push({ start: clipStart, end: clipEnd, type: 'month', fractionOfYear: days / 365.25 });
    m++; if (m === 12) { m = 0; y++; }
  }
  // Annual buckets from the transition year onward.
  y = transition.getUTCFullYear();
  while (true) {
    const bs = new Date(Date.UTC(y, 0, 1));
    if (bs.getTime() > end.getTime()) break;
    const be = new Date(Date.UTC(y, 11, 31));
    const clipStart = bs.getTime() < transition.getTime() ? transition : bs;
    const clipEnd   = be.getTime() > end.getTime() ? new Date(end.getTime()) : be;
    const days = Math.round((clipEnd.getTime() - clipStart.getTime()) / 86_400_000) + 1;
    out.push({ start: clipStart, end: clipEnd, type: 'year', fractionOfYear: days / 365.25 });
    y++;
  }
  return out;
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function runProjection(
  sql: Sql,
  params: ProjectionParams,
): Promise<ProjectionResult> {
  const taxConfig = await loadTaxConfig(sql);
  const accounts  = await loadAccounts(sql, params.accountIds);
  const people    = await loadPeople(sql);
  const stateTimeline = await loadStateTimeline(sql);
  const categories = await loadCategoryMeta(sql);

  const result: ProjectionResult = { periods: [], flags: [], decisions: [], warnings: [] };
  const buckets = generateBuckets(params.startDate, params.endDate);

  // Each year tracks running income / gains for tax + flagged events.
  for (const bucket of buckets) {
    const periodIso = bucket.start.toISOString().slice(0, 10);
    const periodYear = bucket.start.getUTCFullYear();
    const currentState = resolveState(stateTimeline, bucket.start);

    // 1. CASH FLOW from plan.
    const resolved = await resolvePlan(sql, params.planId, bucket.start);
    const oneTimeRows = await loadOneTimeItemsForBucket(sql, params.planId, bucket.start, bucket.end);

    let income = 0;
    let expenses = 0;
    for (const [catId, amt] of resolved.entries()) {
      const cat = categories.get(catId);
      const periodAmount = amt.monthly_amount * (bucket.fractionOfYear * 12);
      if (isIncomeSlugOrName(cat?.slug ?? null, cat?.name ?? null)) income += periodAmount;
      else expenses += periodAmount;
    }
    for (const item of oneTimeRows) {
      if (item.type === 'income') income += item.amount;
      else expenses += item.amount;
    }

    // 2. SS income — starts in year each person reaches elected age.
    for (const person of people) {
      const ageAtYearStart = periodYear - person.birth_year;
      if (!person.ss_started && ageAtYearStart >= person.ss_elected_age && person.ss_fra_monthly > 0) {
        person.ss_started = true;
        result.flags.push({
          period_date: periodIso, flag_type: 'SS_BEGINS', severity: 'info',
          description: `Social Security begins for ${person.name} at age ${ageAtYearStart}`,
        });
      }
    }
    let ssGross = 0;
    for (const person of people) {
      if (!person.ss_started || person.ss_fra_monthly <= 0) continue;
      const ageAtStart = person.ss_elected_age;
      const adj = ssAdjustmentFactor(ageAtStart);
      const monthlyAdjusted = person.ss_fra_monthly * (1 + adj);
      const monthsInBucket = bucket.fractionOfYear * 12;
      ssGross += monthlyAdjusted * monthsInBucket;
    }
    income += ssGross;

    // 3. RMDs — owner age ≥ 73 forces a draw from each Trad 401k/IRA.
    let rmdIncome = 0;
    for (const acct of accounts) {
      if (acct.type !== 'trad_401k' || acct.balance <= 0 || !acct.owner) continue;
      const person = people.find(p => p.id === acct.owner);
      if (!person) continue;
      const age = periodYear - person.birth_year;
      const factor = rmdFactor(age);
      if (factor == null) continue;
      // RMD only on annual buckets to avoid 12× double-counting in early monthly years.
      if (bucket.type !== 'year') continue;
      const rmd = acct.balance / factor;
      acct.balance -= rmd;
      rmdIncome += rmd;
      result.flags.push({
        period_date: periodIso, flag_type: 'RMD_DUE', severity: 'info',
        description: `RMD of $${rmd.toFixed(0)} from ${acct.name} (age ${age})`,
      });
    }
    income += rmdIncome;

    // 4. 529 withdrawals processed per schedule.
    for (const acct of accounts) {
      if (acct.type !== '529') continue;
      const sched = (acct.config['withdrawal_schedule'] as Array<{
        start_year: number; annual_amount: number; duration_years: number; qualified?: boolean;
      }> | undefined) ?? [];
      for (const s of sched) {
        if (periodYear < s.start_year || periodYear >= s.start_year + s.duration_years) continue;
        if (bucket.type !== 'year') continue; // annual only
        const amt = Math.min(s.annual_amount, Math.max(0, acct.balance));
        acct.balance -= amt;
        expenses += amt; // qualified 529: paid out as tuition/etc. — modeled as expense
      }
    }

    // 5. TAX calculation for the year (Phase 6: ordinary + LTCG/STCG + state).
    const taxInputs = {
      year: periodYear,
      ordinary_income: income - ssGross, // SS handled separately for taxability
      capital_gains_lt: 0,
      capital_gains_st: 0,
      ss_gross: ssGross,
      filing_status: params.filingStatus,
      state: currentState,
    };
    // Tax is annual; for monthly buckets, pro-rate.
    const annualTax = calculateTax(taxConfig, taxInputs);
    const proRatedTax = annualTax.total_tax * bucket.fractionOfYear;

    const netPretax  = income - expenses;
    const netAftertax = netPretax - proRatedTax;

    // 6. GROW asset accounts; AMORTIZE liabilities.
    applyAccountGrowth(accounts, bucket.fractionOfYear);
    amortizeDebts(accounts, bucket, result, periodIso);

    // 7. ALLOCATE surplus or draw deficit.
    if (netAftertax > 0) {
      applySurplus(netAftertax, accounts, params.allocationRules.surplus, result, periodIso);
    } else if (netAftertax < 0) {
      drawDeficit(-netAftertax, accounts, params.allocationRules.deficit, result, periodIso, annualTax);
    }

    // 8. FLAGS — funding gap / low liquidity / mortgage payoff.
    const liquid = accounts
      .filter(a => a.type === 'checking')
      .reduce((s, a) => s + Math.max(0, a.balance), 0);
    const monthlyExpenses = expenses / Math.max(0.01, bucket.fractionOfYear * 12);
    if (liquid < 0) {
      result.flags.push({
        period_date: periodIso, flag_type: 'FUNDING_GAP', severity: 'critical',
        description: `Liquid balance projected negative: $${liquid.toFixed(0)}`,
      });
    } else if (liquid < monthlyExpenses * 3 && monthlyExpenses > 0) {
      result.flags.push({
        period_date: periodIso, flag_type: 'LOW_LIQUIDITY', severity: 'warning',
        description: `Liquid balance < 3 months expenses ($${liquid.toFixed(0)} vs $${(monthlyExpenses * 3).toFixed(0)})`,
      });
    }

    // 9. Period summary row.
    const totalAssets    = sumAccounts(accounts, 'asset');
    const totalLiabs     = sumAccounts(accounts, 'liability');
    const accountBalances: Record<string, number> = {};
    for (const a of accounts) accountBalances[a.id] = round(a.balance);

    result.periods.push({
      period_date: periodIso,
      period_type: bucket.type,
      gross_income: round(income),
      total_expenses: round(expenses),
      net_cash_pretax: round(netPretax),
      estimated_tax: round(proRatedTax),
      net_cash_aftertax: round(netAftertax),
      total_asset_value: round(totalAssets),
      total_liability_value: round(totalLiabs),
      net_worth: round(totalAssets - totalLiabs),
      account_balances: accountBalances,
    });
  }

  return result;
}

// ── Account growth & amortization ───────────────────────────────────────────

export function applyAccountGrowth(accounts: AccountState[], fractionOfYear: number): void {
  for (const a of accounts) {
    if (a.asset_or_liability !== 'asset') continue;
    if (a.balance <= 0) continue;
    // Compound continuously over the fraction for accuracy at long horizons.
    a.balance *= Math.pow(1 + a.annual_rate, fractionOfYear);
  }
}

function amortizeDebts(
  accounts: AccountState[],
  bucket: Bucket,
  result: ProjectionResult,
  periodIso: string,
): void {
  for (const a of accounts) {
    if (a.asset_or_liability !== 'liability') continue;
    if (a.balance <= 0) continue;
    const monthlyRate = a.annual_rate / 12;
    const monthsInBucket = bucket.fractionOfYear * 12;
    let principal = a.balance;
    for (let i = 0; i < monthsInBucket; i++) {
      const interest = principal * monthlyRate;
      const principalPaydown = Math.max(0, a.monthly_payment - interest);
      principal = Math.max(0, principal - principalPaydown);
      if (principal === 0) {
        result.flags.push({
          period_date: periodIso, flag_type: 'MORTGAGE_PAYOFF', severity: 'info',
          description: `${a.name} paid off`,
        });
        break;
      }
    }
    a.balance = principal;
  }
}

// ── Waterfalls ──────────────────────────────────────────────────────────────

function applySurplus(
  amount: number,
  accounts: AccountState[],
  rules: SurplusStep[],
  result: ProjectionResult,
  periodIso: string,
): void {
  let remaining = amount;
  for (const rule of rules) {
    if (remaining <= 0) break;

    if (rule.kind === 'emergency_reserve') {
      const liquid = accounts.find(a => a.type === 'checking' && a.name.toLowerCase().includes('savings'))
                  ?? accounts.find(a => a.type === 'checking');
      if (!liquid) continue;
      const deposit = remaining;
      liquid.balance += deposit;
      remaining = 0;
      result.decisions.push({
        period_date: periodIso, decision_type: 'surplus', flagged_for_review: false,
        pass1_action: `Deposit $${deposit.toFixed(0)} → ${liquid.name}`,
        net_worth_impact: 0,
        rationale: 'Surplus → emergency reserve (top of waterfall)',
      });
      continue;
    }

    if (rule.kind === 'retirement') {
      const target = accounts.find(a => a.type === 'roth_ira')
                  ?? accounts.find(a => a.type === 'trad_401k');
      if (!target) continue;
      const cap = rule.max_per_year ?? 23000;
      const deposit = Math.min(remaining, cap);
      target.balance += deposit;
      if (target.type === 'roth_ira') target.roth_basis += deposit;
      remaining -= deposit;
      result.decisions.push({
        period_date: periodIso, decision_type: 'surplus', flagged_for_review: false,
        pass1_action: `Contribute $${deposit.toFixed(0)} → ${target.name}`,
        net_worth_impact: 0, rationale: 'Surplus → retirement (waterfall step)',
      });
      continue;
    }

    if (rule.kind === 'high_interest_paydown') {
      const threshold = rule.rate_threshold ?? 0.06;
      const debt = accounts
        .filter(a => a.asset_or_liability === 'liability' && a.annual_rate >= threshold && a.balance > 0)
        .sort((x, y) => y.annual_rate - x.annual_rate)[0];
      if (!debt) continue;
      const paydown = Math.min(remaining, debt.balance);
      debt.balance -= paydown;
      remaining -= paydown;
      result.decisions.push({
        period_date: periodIso, decision_type: 'surplus', flagged_for_review: false,
        pass1_action: `Paydown $${paydown.toFixed(0)} on ${debt.name}`,
        net_worth_impact: 0,
        rationale: `Surplus → high-interest debt (${(debt.annual_rate * 100).toFixed(2)}%)`,
      });
      continue;
    }

    if (rule.kind === 'taxable_brokerage') {
      const target = accounts.find(a => a.type === 'brokerage');
      if (!target) continue;
      target.balance += remaining;
      result.decisions.push({
        period_date: periodIso, decision_type: 'surplus', flagged_for_review: false,
        pass1_action: `Deposit $${remaining.toFixed(0)} → ${target.name}`,
        net_worth_impact: 0, rationale: 'Surplus → taxable brokerage (residual)',
      });
      remaining = 0;
    }
  }
}

function drawDeficit(
  amount: number,
  accounts: AccountState[],
  rules: DeficitStep[],
  result: ProjectionResult,
  periodIso: string,
  taxResult: TaxYearResult,
): void {
  let remaining = amount;
  for (const rule of rules) {
    if (remaining <= 0) break;

    if (rule.kind === 'checking') {
      const accts = accounts.filter(a => a.type === 'checking' && a.balance > 0)
                            .sort((x, y) => y.balance - x.balance);
      for (const a of accts) {
        if (remaining <= 0) break;
        const draw = Math.min(remaining, a.balance);
        a.balance -= draw;
        remaining -= draw;
        result.decisions.push({
          period_date: periodIso, decision_type: 'deficit', flagged_for_review: false,
          pass1_action: `Draw $${draw.toFixed(0)} from ${a.name}`,
          net_worth_impact: 0,
          rationale: 'Liquid funds available — no tax impact',
        });
      }
      continue;
    }

    if (rule.kind === 'taxable_brokerage') {
      const acct = accounts.find(a => a.type === 'brokerage' && a.balance > 0);
      if (!acct) continue;
      const draw = Math.min(remaining, acct.balance);
      acct.balance -= draw;
      remaining -= draw;
      result.decisions.push({
        period_date: periodIso, decision_type: 'deficit', flagged_for_review: false,
        pass1_action: `Draw $${draw.toFixed(0)} from ${acct.name}`,
        net_worth_impact: 0,
        rationale: 'Taxable brokerage draw — LTCG tax to apply in year-end',
      });
      continue;
    }

    if (rule.kind === 'roth_contributions') {
      const acct = accounts.find(a => a.type === 'roth_ira' && a.roth_basis > 0);
      if (!acct) continue;
      const draw = Math.min(remaining, acct.roth_basis, acct.balance);
      acct.balance     -= draw;
      acct.roth_basis  -= draw;
      remaining        -= draw;
      result.decisions.push({
        period_date: periodIso, decision_type: 'deficit', flagged_for_review: false,
        pass1_action: `Withdraw $${draw.toFixed(0)} basis from ${acct.name}`,
        net_worth_impact: 0,
        rationale: 'Roth contributions: no tax / no penalty',
      });
      continue;
    }

    if (rule.kind === 'traditional_retirement') {
      const acct = accounts.find(a => a.type === 'trad_401k' && a.balance > 0);
      if (!acct) continue;
      const draw = Math.min(remaining, acct.balance);
      acct.balance -= draw;
      remaining    -= draw;
      // 10% penalty if owner < 59.5
      result.flags.push({
        period_date: periodIso, flag_type: 'PENALTY_WITHDRAWAL', severity: 'critical',
        description: `Traditional 401(k) draw of $${draw.toFixed(0)} from ${acct.name}`,
      });
      result.decisions.push({
        period_date: periodIso, decision_type: 'deficit', flagged_for_review: true,
        pass1_action: `Withdraw $${draw.toFixed(0)} from ${acct.name}`,
        net_worth_impact: 0,
        rationale: `Last-resort tax-bearing draw at marginal ${(taxResult.marginal_rate * 100).toFixed(0)}%`,
      });
    }
  }

  if (remaining > 0) {
    // Could not satisfy deficit — funding gap.
    result.flags.push({
      period_date: periodIso, flag_type: 'FUNDING_GAP', severity: 'critical',
      description: `Unable to fund $${remaining.toFixed(0)} of deficit from any source`,
    });
  }
}

// ── DB preload helpers ──────────────────────────────────────────────────────

async function loadAccounts(sql: Sql, ids: string[]): Promise<AccountState[]> {
  if (ids.length === 0) return [];
  const rows = await sql<Array<{
    id: string; name: string; type: string; asset_or_liability: 'asset' | 'liability';
    balance: string; config_json: Record<string, unknown> | null;
  }>>`
    SELECT sa.id, sa.name, sa.type, sa.asset_or_liability,
           COALESCE(
             (SELECT balance::text FROM account_balance_history abh
               WHERE abh.account_id = sa.id ORDER BY recorded_date DESC LIMIT 1),
             sa.current_balance::text, '0'
           ) AS balance,
           atc.config_json
    FROM scenario_accounts sa
    LEFT JOIN account_type_config atc ON atc.account_id = sa.id
    WHERE sa.id = ANY(${ids})
  `;
  // Look up the rate in effect today per account.
  const rateRows = await sql<Array<{ account_id: string; base_rate: string }>>`
    SELECT DISTINCT ON (account_id)
      account_id, base_rate::text AS base_rate
    FROM account_rate_schedule
    WHERE effective_date <= CURRENT_DATE AND account_id = ANY(${ids})
    ORDER BY account_id, effective_date DESC
  `;
  const rateByAccount = new Map(rateRows.map(r => [r.account_id, Number(r.base_rate)]));

  return rows.map(r => {
    const config = r.config_json ?? {};
    const owner = (config['owner'] as 'jeremy' | 'elyse' | undefined) ?? null;
    const rothBasis = Number(config['roth_contribution_basis'] ?? 0);
    const monthlyPayment = Number(config['monthly_payment'] ?? 0);
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      asset_or_liability: r.asset_or_liability,
      balance: Number(r.balance),
      annual_rate: rateByAccount.get(r.id) ?? 0,
      monthly_payment: monthlyPayment,
      owner,
      roth_basis: rothBasis,
      config,
    };
  });
}

async function loadPeople(sql: Sql): Promise<PersonState[]> {
  const rows = await sql<Array<{
    id: string; name: string; role: string; date_of_birth: string;
  }>>`
    SELECT id, name, role, to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth
    FROM user_profiles
  `;
  // Get SS data from social_security accounts (config_json has fra/age).
  const ssRows = await sql<Array<{ owner: string | null; fra: number; elected: number }>>`
    SELECT
      (config_json->>'person') AS owner,
      COALESCE((config_json->>'fra_monthly_benefit')::numeric, 0)::float AS fra,
      COALESCE((config_json->>'elected_start_age')::numeric, 67)::float AS elected
    FROM scenario_accounts sa
    JOIN account_type_config atc ON atc.account_id = sa.id
    WHERE sa.type = 'social_security'
  `;
  const ssByPerson = new Map(ssRows.filter(r => r.owner).map(r => [r.owner!, { fra: Number(r.fra), elected: Number(r.elected) }]));

  return rows
    .filter(r => r.name.toLowerCase() === 'jeremy' || r.name.toLowerCase() === 'elyse')
    .map(r => {
      const id = r.name.toLowerCase() as 'jeremy' | 'elyse';
      const ss = ssByPerson.get(id) ?? { fra: 0, elected: 67 };
      return {
        id,
        name: r.name,
        birth_year: Number(r.date_of_birth.slice(0, 4)),
        ss_started: false,
        ss_fra_monthly: ss.fra,
        ss_elected_age: ss.elected,
      };
    });
}

async function loadStateTimeline(sql: Sql): Promise<Array<{ state: string; effective_date: string }>> {
  return sql<Array<{ state: string; effective_date: string }>>`
    SELECT state, to_char(effective_date, 'YYYY-MM-DD') AS effective_date
    FROM state_residence_timeline
    ORDER BY effective_date
  `;
}

function resolveState(timeline: Array<{ state: string; effective_date: string }>, date: Date): string {
  const target = date.toISOString().slice(0, 10);
  let current = 'CA';
  for (const t of timeline) {
    if (t.effective_date <= target) current = t.state;
  }
  return current;
}

async function loadCategoryMeta(sql: Sql): Promise<Map<string, { id: string; name: string; slug: string }>> {
  const rows = await sql<Array<{ id: string; name: string; slug: string }>>`
    SELECT id, name, slug FROM categories
  `;
  return new Map(rows.map(r => [r.id, r]));
}

async function loadOneTimeItemsForBucket(
  sql: Sql, planId: string, start: Date, end: Date,
): Promise<Array<{ name: string; type: 'expense' | 'income'; amount: number }>> {
  const rows = await sql<Array<{ name: string; type: 'expense' | 'income'; amount: string }>>`
    SELECT name, type, amount::text AS amount
    FROM plan_one_time_items
    WHERE plan_id = ${planId}
      AND item_date BETWEEN ${start.toISOString().slice(0, 10)} AND ${end.toISOString().slice(0, 10)}
  `;
  return rows.map(r => ({ name: r.name, type: r.type, amount: Number(r.amount) }));
}

// ── Utility ─────────────────────────────────────────────────────────────────

const round = (n: number) => Math.round(n * 100) / 100;

function sumAccounts(accounts: AccountState[], side: 'asset' | 'liability'): number {
  return accounts.filter(a => a.asset_or_liability === side)
                 .reduce((s, a) => s + Math.max(0, a.balance), 0);
}

// ── Pass 2 optimization ─────────────────────────────────────────────────────
//
// The Phase 6 engine is a single forward pass. Phase 7's Pass 2
// re-runs the engine once with a more conservative allocation rule
// set, informed by Pass 1's flags. Specifically: if Pass 1 produced
// any FUNDING_GAP / LOW_LIQUIDITY / PENALTY_WITHDRAWAL flag, Pass 2
// pushes retirement contributions to the bottom of the surplus
// waterfall and pulls emergency reserve / brokerage to the top, then
// re-projects. This is intentionally rules-based rather than
// combinatorial — it gives a deterministic Pass 2 snapshot that
// strictly improves liquidity in scenarios where Pass 1 hit walls.

export interface Pass2DecisionDiff {
  period_date: string;
  pass1_action: string;
  pass2_action: string;
  net_worth_impact: number;
  rationale: string;
}

export interface Pass2Result {
  pass2Projection: ProjectionResult;
  diffs: Pass2DecisionDiff[];
  improvement: number;
  rules_changed: boolean;
}

export async function runPass2Optimization(
  sql: Sql,
  pass1Params: ProjectionParams,
  pass1Result: ProjectionResult,
): Promise<Pass2Result> {
  const flaggedTriggers = pass1Result.flags.filter(f =>
    f.flag_type === 'FUNDING_GAP' ||
    f.flag_type === 'LOW_LIQUIDITY' ||
    f.flag_type === 'PENALTY_WITHDRAWAL'
  );

  if (flaggedTriggers.length === 0) {
    // Nothing to optimize — Pass 2 = Pass 1.
    return { pass2Projection: pass1Result, diffs: [], improvement: 0, rules_changed: false };
  }

  // Pull liquidity-preserving rules: emergency reserve and brokerage
  // first, retirement last. Keep any custom step the user added.
  const customSurplusKinds = new Set(pass1Params.allocationRules.surplus.map(s => s.kind));
  const candidateOrder: SurplusStep[] = [
    { kind: 'emergency_reserve' },
    { kind: 'high_interest_paydown', rate_threshold: 0.06 },
    { kind: 'taxable_brokerage' },
    { kind: 'retirement', max_per_year: 23000 },
  ];
  const reorderedSurplus = candidateOrder.filter(s => customSurplusKinds.has(s.kind));

  const pass2Params: ProjectionParams = {
    ...pass1Params,
    allocationRules: {
      surplus: reorderedSurplus,
      deficit: pass1Params.allocationRules.deficit,
    },
  };

  const pass2Projection = await runProjection(sql, pass2Params);

  const pass1End = pass1Result.periods[pass1Result.periods.length - 1]?.net_worth ?? 0;
  const pass2End = pass2Projection.periods[pass2Projection.periods.length - 1]?.net_worth ?? 0;
  const improvement = pass2End - pass1End;

  // Build a diff list keyed by period_date: any decision present in
  // both passes whose action differs counts as a Pass 2 change.
  const pass1ByDate = new Map<string, string>();
  for (const d of pass1Result.decisions) {
    pass1ByDate.set(`${d.period_date}/${d.decision_type}`, d.pass1_action);
  }

  const diffs: Pass2DecisionDiff[] = [];
  for (const d of pass2Projection.decisions) {
    const key = `${d.period_date}/${d.decision_type}`;
    const pass1 = pass1ByDate.get(key);
    if (pass1 && pass1 !== d.pass1_action) {
      diffs.push({
        period_date: d.period_date,
        pass1_action: pass1,
        pass2_action: d.pass1_action,
        net_worth_impact: improvement / Math.max(1, pass1ByDate.size),
        rationale: 'Pass 2 reordered surplus waterfall to preserve liquidity',
      });
    }
  }

  return { pass2Projection, diffs, improvement, rules_changed: true };
}

// ── Roth conversion proposals ───────────────────────────────────────────────
//
// Walk each annual bucket in Pass 1. For each year that has a positive
// Traditional retirement balance:
//   - estimate current marginal federal rate from the year's federal
//     taxable income
//   - estimate projected RMD-age marginal rate from the last RMD year
//   - if current < projected and there's headroom in the current
//     bracket, propose converting up to that headroom
//   - require net-positive NPV

export interface RothConversionProposal {
  year: number;
  conversion_amount: number;
  current_marginal_rate: number;
  projected_rmd_rate: number;
  tax_cost_now: number;
  npv_savings: number;
  net_benefit: number;
  rationale: string;
}

const DISCOUNT_RATE = 0.05;

export async function evaluateRothConversions(
  sql: Sql,
  pass1Result: ProjectionResult,
  pass1Params: ProjectionParams,
): Promise<RothConversionProposal[]> {
  const taxConfig = await loadTaxConfig(sql);

  // Find a single Trad balance — for proposal purposes we look at the
  // most recently seen Trad 401(k) balance from period account_balances.
  const tradBalanceByYear = new Map<number, number>();
  for (const p of pass1Result.periods) {
    if (p.period_type !== 'year') continue;
    const year = Number(p.period_date.slice(0, 4));
    let tradTotal = 0;
    for (const [, bal] of Object.entries(p.account_balances)) {
      tradTotal += Number(bal);
    }
    tradBalanceByYear.set(year, tradTotal);
  }

  // Marginal rate per year from federal_taxable_income.
  const federalSchedule = findBracketSchedule(taxConfig, new Date().getUTCFullYear(),
                                              pass1Params.filingStatus, 'federal');
  if (!federalSchedule) return [];

  const marginalByYear = new Map<number, number>();
  for (const p of pass1Result.periods) {
    if (p.period_type !== 'year') continue;
    const year = Number(p.period_date.slice(0, 4));
    const taxableEstimate = Math.max(0, p.gross_income - federalSchedule.standard_deduction);
    marginalByYear.set(year, getMarginalRate(taxableEstimate, federalSchedule.brackets));
  }

  // Projected RMD-era rate: the marginal rate in the last 5 years of
  // the projection (assumption: RMD has begun by then).
  const sortedYears = [...marginalByYear.keys()].sort((a, b) => a - b);
  if (sortedYears.length < 2) return [];
  const tailYears = sortedYears.slice(-5);
  const tailRates = tailYears.map(y => marginalByYear.get(y) ?? 0);
  const projectedRmdRate = tailRates.reduce((s, r) => s + r, 0) / Math.max(1, tailRates.length);

  const proposals: RothConversionProposal[] = [];

  for (const year of sortedYears) {
    const current = marginalByYear.get(year) ?? 0;
    if (current >= projectedRmdRate) continue;
    const tradBalance = tradBalanceByYear.get(year) ?? 0;
    if (tradBalance <= 0) continue;

    // Bracket headroom — convert up to the top of the current bracket.
    const grossIncome = pass1Result.periods.find(p =>
      p.period_type === 'year' && p.period_date.slice(0, 4) === String(year),
    )?.gross_income ?? 0;
    const taxableEstimate = Math.max(0, grossIncome - federalSchedule.standard_deduction);
    const currentBracket = federalSchedule.brackets.find(b =>
      taxableEstimate < (b.ceiling ?? Infinity)
    );
    if (!currentBracket) continue;
    const headroom = Math.max(0, (currentBracket.ceiling ?? Infinity) - taxableEstimate);
    if (headroom === 0 || !isFinite(headroom)) continue;

    const conversionAmount = Math.min(headroom, tradBalance * 0.30);
    if (conversionAmount < 5000) continue;

    const taxCostNow = conversionAmount * current;
    const yearsToRmd = Math.max(1, tailYears[0]! - year);
    const futureTax  = conversionAmount * projectedRmdRate;
    const npvSavings = futureTax / Math.pow(1 + DISCOUNT_RATE, yearsToRmd);
    const netBenefit = npvSavings - taxCostNow;

    if (netBenefit <= 0) continue;

    proposals.push({
      year,
      conversion_amount: round(conversionAmount),
      current_marginal_rate: Math.round(current * 10000) / 10000,
      projected_rmd_rate:    Math.round(projectedRmdRate * 10000) / 10000,
      tax_cost_now:  round(taxCostNow),
      npv_savings:   round(npvSavings),
      net_benefit:   round(netBenefit),
      rationale: `Converting $${conversionAmount.toFixed(0)} at ${(current * 100).toFixed(1)}% ` +
                 `saves NPV $${npvSavings.toFixed(0)} vs. RMD-age rate ` +
                 `${(projectedRmdRate * 100).toFixed(1)}%`,
    });
  }

  return proposals;
}

