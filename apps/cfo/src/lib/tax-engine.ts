/**
 * Tax engine — Phase 6 scope.
 *
 *   ordinary income + LTCG/STCG + state tax + SS taxability
 *
 * AMT, NIIT, QBI, depreciation recapture are Phase 7 — left unimplemented
 * here. Numbers are loaded from `tax_bracket_schedules` and
 * `capital_gains_config` (seeded by migration 0013).
 *
 * The projection engine preloads a TaxConfigSet once for the run, then
 * `calculateTax()` is a pure function over that config so the inner
 * year loop never hits the database.
 */

import type { Sql } from './db';

export interface Bracket { floor: number; ceiling: number | null; rate: number }

export interface BracketSchedule {
  year: number;
  filing_status: string;
  jurisdiction: string;
  brackets: Bracket[];
  standard_deduction: number;
}

export interface CapitalGainsConfig {
  year: number;
  jurisdiction: string;
  ltcg_brackets: Bracket[] | null;
  niit_rate: number;
  niit_threshold: number;
  stcg_as_ordinary: boolean;
}

export interface DeductionConfig {
  type: 'salt' | 'charitable' | 'mortgage_interest' | 'other';
  annual_amount: number;
  effective_date: string;  // YYYY-MM-DD
  source: string;
}

export interface TaxConfigSet {
  ordinaryBrackets: BracketSchedule[];        // all jurisdictions, all years
  capitalGains:     CapitalGainsConfig[];
  deductions:       DeductionConfig[];
}

export async function loadTaxConfig(sql: Sql): Promise<TaxConfigSet> {
  const ordinary = await sql<Array<{
    year: number; filing_status: string; jurisdiction: string;
    brackets_json: Bracket[]; standard_deduction: string | null;
  }>>`
    SELECT year, filing_status, jurisdiction, brackets_json, standard_deduction::text AS standard_deduction
    FROM tax_bracket_schedules
  `;
  const cg = await sql<Array<{
    year: number; jurisdiction: string;
    ltcg_brackets_json: Bracket[] | null;
    niit_rate: string; niit_threshold: string; stcg_as_ordinary: boolean;
  }>>`
    SELECT year, jurisdiction, ltcg_brackets_json,
           niit_rate::text AS niit_rate, niit_threshold::text AS niit_threshold,
           stcg_as_ordinary
    FROM capital_gains_config
  `;
  const ded = await sql<Array<{
    type: string; annual_amount: string; effective_date: string; source: string;
  }>>`
    SELECT type, annual_amount::text AS annual_amount,
           to_char(effective_date, 'YYYY-MM-DD') AS effective_date, source
    FROM tax_deduction_config
  `;
  return {
    ordinaryBrackets: ordinary.map(o => ({
      year: o.year,
      filing_status: o.filing_status,
      jurisdiction: o.jurisdiction,
      brackets: o.brackets_json,
      standard_deduction: o.standard_deduction == null ? 0 : Number(o.standard_deduction),
    })),
    capitalGains: cg.map(c => ({
      year: c.year,
      jurisdiction: c.jurisdiction,
      ltcg_brackets: c.ltcg_brackets_json,
      niit_rate: Number(c.niit_rate),
      niit_threshold: Number(c.niit_threshold),
      stcg_as_ordinary: c.stcg_as_ordinary,
    })),
    deductions: ded.map(d => ({
      type: d.type as DeductionConfig['type'],
      annual_amount: Number(d.annual_amount),
      effective_date: d.effective_date,
      source: d.source,
    })),
  };
}

// ── Core bracket math ───────────────────────────────────────────────────────

/**
 * Apply a progressive bracket schedule to a slice of income that sits
 * on top of an existing income stack. Used both for plain ordinary
 * (stackedOn = 0) and for LTCG bracket stacking on top of ordinary.
 */
export function applyBrackets(income: number, brackets: Bracket[], stackedOn = 0): number {
  if (income <= 0) return 0;
  let tax = 0;
  const stackTop = stackedOn + income;
  for (const b of brackets) {
    const ceil = b.ceiling ?? Infinity;
    const sliceFloor = Math.max(b.floor, stackedOn);
    const sliceCeil  = Math.min(ceil, stackTop);
    const taxable = Math.max(0, sliceCeil - sliceFloor);
    tax += taxable * b.rate;
    if (stackTop <= ceil) break;
  }
  return tax;
}

export function getMarginalRate(income: number, brackets: Bracket[]): number {
  for (const b of brackets) {
    const ceil = b.ceiling ?? Infinity;
    if (income < ceil) return b.rate;
  }
  return brackets[brackets.length - 1]?.rate ?? 0;
}

// ── Lookup helpers ──────────────────────────────────────────────────────────

/**
 * Find the bracket schedule for a (year, filing_status, jurisdiction).
 * Falls back to the latest year we have on file ≤ the target year.
 */
export function findBracketSchedule(
  cfg: TaxConfigSet,
  year: number,
  filingStatus: string,
  jurisdiction: string,
): BracketSchedule | null {
  const candidates = cfg.ordinaryBrackets
    .filter(s => s.filing_status === filingStatus && s.jurisdiction === jurisdiction && s.year <= year)
    .sort((a, b) => b.year - a.year);
  return candidates[0] ?? null;
}

export function findCapitalGainsConfig(
  cfg: TaxConfigSet,
  year: number,
  jurisdiction: string,
): CapitalGainsConfig | null {
  const candidates = cfg.capitalGains
    .filter(c => c.jurisdiction === jurisdiction && c.year <= year)
    .sort((a, b) => b.year - a.year);
  return candidates[0] ?? null;
}

// ── SS taxability ───────────────────────────────────────────────────────────

/**
 * Combined-income test for SS taxability (MFJ thresholds).
 * Up to 85% of SS may be taxable.
 */
export function calculateSsTaxableIncome(
  ssGross: number,
  otherAgi: number,
  taxExemptInterest: number,
): number {
  if (ssGross <= 0) return 0;
  const combined = otherAgi + taxExemptInterest + ssGross * 0.5;
  if (combined < 32000) return 0;
  if (combined < 44000) {
    return Math.min(ssGross * 0.5, (combined - 32000) * 0.5);
  }
  const base       = Math.min(ssGross * 0.5, (44000 - 32000) * 0.5);
  const additional = Math.min(ssGross * 0.85, (combined - 44000) * 0.85);
  return Math.min(ssGross * 0.85, base + additional);
}

// ── Deductions ──────────────────────────────────────────────────────────────

export function getItemizedDeductions(cfg: TaxConfigSet, year: number): number {
  // Sum all deductions whose effective_date is in or before this year.
  const yearEnd = `${year}-12-31`;
  let total = 0;
  for (const d of cfg.deductions) {
    if (d.effective_date <= yearEnd) total += d.annual_amount;
  }
  // SALT cap (TCJA): $10,000 ceiling on the SALT portion.
  // We approximate by capping the 'salt' line items only.
  const saltTotal = cfg.deductions
    .filter(d => d.type === 'salt' && d.effective_date <= yearEnd)
    .reduce((s, d) => s + d.annual_amount, 0);
  const saltOverage = Math.max(0, saltTotal - 10000);
  return Math.max(0, total - saltOverage);
}

// ── Main entry ──────────────────────────────────────────────────────────────

export interface TaxYearInputs {
  year: number;
  ordinary_income: number;
  capital_gains_lt: number;
  capital_gains_st: number;
  ss_gross: number;
  filing_status: string;
  state: string;
  /** Non-W2 / passive interest (rare; default 0). */
  tax_exempt_interest?: number;

  // Phase 7 inputs — full tax engine.
  iso_spread_exercised?: number;                  // AMT preference
  rental_income_net?: number;                     // NIIT
  qbi_by_entity?: Record<string, number>;         // {elyse_coaching: X, jeremy_coaching: Y}
  w2_wages_by_entity?: Record<string, number>;    // used by QBI above the SSTB threshold
}

export interface TaxYearResult {
  federal_ordinary_tax: number;
  ltcg_tax: number;
  amt: number;
  niit: number;
  state_tax: number;
  total_tax: number;
  effective_rate: number;
  marginal_rate: number;
  ss_taxable_amount: number;
  deductions_used: number;
  qbi_deduction: number;
  itemized_vs_standard: 'itemized' | 'standard';
  breakdown: Record<string, number>;
}

export function calculateTax(cfg: TaxConfigSet, inputs: TaxYearInputs): TaxYearResult {
  const fed = findBracketSchedule(cfg, inputs.year, inputs.filing_status, 'federal');
  if (!fed) {
    return zeroResult();
  }
  const state = findBracketSchedule(cfg, inputs.year, inputs.filing_status, inputs.state);

  const ssTaxable = calculateSsTaxableIncome(
    inputs.ss_gross,
    inputs.ordinary_income + inputs.capital_gains_lt,
    inputs.tax_exempt_interest ?? 0,
  );

  // STCG taxed as ordinary (default at federal level).
  const totalOrdinary = inputs.ordinary_income + inputs.capital_gains_st + ssTaxable;

  // QBI deduction sits below standard/itemized and above regular tax math.
  const qbiDeduction = calculateQbiDeduction(
    inputs.qbi_by_entity ?? {},
    totalOrdinary,
    inputs.w2_wages_by_entity ?? {},
    inputs.year,
  );

  const itemized = getItemizedDeductions(cfg, inputs.year);
  const standard = fed.standard_deduction;
  const itemizedVsStandard = itemized > standard ? 'itemized' : 'standard';
  const deductions = Math.max(itemized, standard) + qbiDeduction;

  const federalTaxable = Math.max(0, totalOrdinary - deductions);
  const federalOrdinary = applyBrackets(federalTaxable, fed.brackets);

  const ltcgCfg = findCapitalGainsConfig(cfg, inputs.year, 'federal');
  const ltcgTax = (inputs.capital_gains_lt > 0 && ltcgCfg?.ltcg_brackets)
    ? applyBrackets(inputs.capital_gains_lt, ltcgCfg.ltcg_brackets, federalTaxable)
    : 0;

  // AMT: regular taxable + ISO spread + SALT addback (estimated as the
  // SALT portion of itemized deductions, capped at $10K).
  const saltDeducted = Math.min(10000, (cfg.deductions
    .filter(d => d.type === 'salt' && d.effective_date <= `${inputs.year}-12-31`)
    .reduce((s, d) => s + d.annual_amount, 0)));
  const amt = calculateAmt(
    federalTaxable,
    inputs.iso_spread_exercised ?? 0,
    itemizedVsStandard === 'itemized' ? saltDeducted : 0,
    inputs.year,
    inputs.filing_status,
    federalOrdinary,
  );

  // NIIT — net investment income above the MAGI threshold.
  const nii = inputs.capital_gains_lt + inputs.capital_gains_st + (inputs.rental_income_net ?? 0);
  const magi = totalOrdinary + inputs.capital_gains_lt;
  const niit = calculateNiit(nii, magi, inputs.year, inputs.filing_status);

  let stateTax = 0;
  if (state) {
    const stateDeduction = state.standard_deduction;
    const stateOrdinary = totalOrdinary + inputs.capital_gains_lt;
    const stateTaxable  = Math.max(0, stateOrdinary - stateDeduction);
    stateTax = applyBrackets(stateTaxable, state.brackets);
  }

  const totalFederal = federalOrdinary + ltcgTax + amt + niit;
  const total = totalFederal + stateTax;
  const totalGross = totalOrdinary + inputs.capital_gains_lt;
  const effective = totalGross > 0 ? total / totalGross : 0;
  const marginal  = getMarginalRate(federalTaxable, fed.brackets);

  return {
    federal_ordinary_tax: round(federalOrdinary),
    ltcg_tax: round(ltcgTax),
    amt: round(amt),
    niit: round(niit),
    state_tax: round(stateTax),
    total_tax: round(total),
    effective_rate: round4(effective),
    marginal_rate: round4(marginal),
    ss_taxable_amount: round(ssTaxable),
    deductions_used: round(deductions),
    qbi_deduction: round(qbiDeduction),
    itemized_vs_standard: itemizedVsStandard,
    breakdown: {
      federal_taxable_income: round(federalTaxable),
      ordinary_income_total:  round(totalOrdinary),
      iso_spread:             round(inputs.iso_spread_exercised ?? 0),
      net_investment_income:  round(nii),
      magi:                   round(magi),
    },
  };
}

function zeroResult(): TaxYearResult {
  return {
    federal_ordinary_tax: 0, ltcg_tax: 0, amt: 0, niit: 0, state_tax: 0, total_tax: 0,
    effective_rate: 0, marginal_rate: 0,
    ss_taxable_amount: 0, deductions_used: 0, qbi_deduction: 0,
    itemized_vs_standard: 'standard',
    breakdown: {},
  };
}

// ── AMT ─────────────────────────────────────────────────────────────────────
//
// 2025 MFJ values from docs/cfo-scenarios-supplemental-spec.md:
//   exemption: $137,000; phaseout floor: $1,237,450; rates: 26% up to
//   $232,600 AMTI, 28% above. AMT owed = max(0, tentative_min_tax − regular_tax).

const AMT_EXEMPTION_MFJ_2025  = 137000;
const AMT_PHASEOUT_MFJ_2025   = 1237450;
const AMT_RATE_BREAK_2025     = 232600;

export function calculateAmt(
  regularTaxableIncome: number,
  isoSpreadExercised: number,
  saltDeductionTaken: number,
  _year: number,
  _filingStatus: string,
  regularFederalTax: number,
): number {
  if (regularTaxableIncome <= 0 && isoSpreadExercised <= 0) return 0;
  const amti = regularTaxableIncome + isoSpreadExercised + saltDeductionTaken;
  let exemption = AMT_EXEMPTION_MFJ_2025;
  if (amti > AMT_PHASEOUT_MFJ_2025) {
    const reduction = (amti - AMT_PHASEOUT_MFJ_2025) * 0.25;
    exemption = Math.max(0, exemption - reduction);
  }
  const afterExemption = Math.max(0, amti - exemption);
  const tentativeMinTax = afterExemption <= AMT_RATE_BREAK_2025
    ? afterExemption * 0.26
    : AMT_RATE_BREAK_2025 * 0.26 + (afterExemption - AMT_RATE_BREAK_2025) * 0.28;
  return Math.max(0, tentativeMinTax - regularFederalTax);
}

// ── NIIT ────────────────────────────────────────────────────────────────────

const NIIT_THRESHOLD_MFJ_2025 = 250000;
const NIIT_RATE_2025          = 0.038;

export function calculateNiit(
  netInvestmentIncome: number,
  magi: number,
  _year: number,
  _filingStatus: string,
): number {
  if (magi <= NIIT_THRESHOLD_MFJ_2025) return 0;
  if (netInvestmentIncome <= 0) return 0;
  const niitBase = Math.min(netInvestmentIncome, magi - NIIT_THRESHOLD_MFJ_2025);
  return niitBase * NIIT_RATE_2025;
}

// ── QBI (§199A) ─────────────────────────────────────────────────────────────
//
// All coaching businesses in this household are treated as SSTB
// (consulting / health / financial → IRS classifies as SSTB). Below
// $383,900 MFJ taxable income: full 20% deduction. Above $483,900 MFJ:
// zero. Phase-in linear between.

const QBI_THRESHOLD_LOWER_MFJ_2025 = 383900;
const QBI_THRESHOLD_UPPER_MFJ_2025 = 483900;

export function calculateQbiDeduction(
  qbiByEntity: Record<string, number>,
  totalTaxableIncome: number,
  _w2WagesByEntity: Record<string, number>,
  _year: number,
): number {
  let total = 0;
  for (const qbi of Object.values(qbiByEntity)) {
    if (qbi <= 0) continue;
    const tentative = qbi * 0.20;
    let entity = 0;
    if (totalTaxableIncome <= QBI_THRESHOLD_LOWER_MFJ_2025) {
      entity = tentative;
    } else if (totalTaxableIncome >= QBI_THRESHOLD_UPPER_MFJ_2025) {
      entity = 0;
    } else {
      const phaseOutPct = (totalTaxableIncome - QBI_THRESHOLD_LOWER_MFJ_2025) /
                          (QBI_THRESHOLD_UPPER_MFJ_2025 - QBI_THRESHOLD_LOWER_MFJ_2025);
      entity = tentative * (1 - phaseOutPct);
    }
    total += entity;
  }
  // Overall cap: 20% of taxable income.
  return Math.min(total, totalTaxableIncome * 0.20);
}

// ── Depreciation recapture (residential real estate, §1250 gain) ─────────────

export interface DepreciationRecaptureResult {
  recaptureTax: number;
  ltcgTax: number;
  totalTax: number;
  totalGain: number;
  recaptureGain: number;
  capitalGain: number;
}

export function calculateDepreciationRecapture(
  salePrice: number,
  purchasePrice: number,
  accumulatedDepreciation: number,
  taxConfig: TaxConfigSet,
  year: number,
  stackedOnOrdinary: number,
): DepreciationRecaptureResult {
  const adjustedBasis = purchasePrice - accumulatedDepreciation;
  const totalGain = Math.max(0, salePrice - adjustedBasis);
  const recaptureGain = Math.min(accumulatedDepreciation, totalGain);
  const recaptureTax = recaptureGain * 0.25;
  const capitalGain = Math.max(0, totalGain - recaptureGain);
  let ltcgTax = 0;
  if (capitalGain > 0) {
    const ltcgCfg = findCapitalGainsConfig(taxConfig, year, 'federal');
    if (ltcgCfg?.ltcg_brackets) {
      ltcgTax = applyBrackets(capitalGain, ltcgCfg.ltcg_brackets, stackedOnOrdinary);
    }
  }
  return {
    recaptureTax: round(recaptureTax),
    ltcgTax:      round(ltcgTax),
    totalTax:     round(recaptureTax + ltcgTax),
    totalGain:    round(totalGain),
    recaptureGain: round(recaptureGain),
    capitalGain:   round(capitalGain),
  };
}

/**
 * Annual residential depreciation: (purchase_price − land_value) / 27.5.
 * Land is treated as 25% of purchase price when not separately tracked
 * (matches the supplemental's "20–30%" guidance).
 */
export function annualResidentialDepreciation(purchasePrice: number, landValueOverride?: number): number {
  const land = landValueOverride ?? purchasePrice * 0.25;
  const depreciableBasis = Math.max(0, purchasePrice - land);
  return depreciableBasis / 27.5;
}

const round  = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

// ── SS adjustment factors ───────────────────────────────────────────────────

const SS_ADJUSTMENTS: Record<number, number> = {
  62: -0.30, 63: -0.25, 64: -0.20, 65: -0.133, 66: -0.067,
  67: 0,
  68: 0.08, 69: 0.16, 70: 0.24,
};

export function ssAdjustmentFactor(electedAge: number): number {
  if (electedAge <= 62) return SS_ADJUSTMENTS[62]!;
  if (electedAge >= 70) return SS_ADJUSTMENTS[70]!;
  const key = Math.round(electedAge);
  return SS_ADJUSTMENTS[key] ?? 0;
}

// ── RMD factors (IRS Uniform Lifetime Table) ────────────────────────────────

export const RMD_FACTORS: Record<number, number> = {
  73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1,
  80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0,
  86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2,
};

export function rmdFactor(age: number): number | null {
  if (age < 73) return null;
  if (age > 90) return RMD_FACTORS[90] ?? null;
  return RMD_FACTORS[age] ?? null;
}
