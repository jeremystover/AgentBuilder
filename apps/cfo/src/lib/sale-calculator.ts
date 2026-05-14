/**
 * Sale-at-date proceeds calculator (Phase 7 step 7).
 *
 * Pure function over an account + sale date + tax config. Projects the
 * market value forward from the most recent balance via the account's
 * configured rate, then computes:
 *   - depreciation recapture (real estate investment, §1250 gain)
 *   - capital gain (federal LTCG rates, stacked on ordinary income)
 *   - §121 exclusion for a primary residence (up to $500K MFJ)
 *
 * The result is purely advisory — it doesn't mutate any state. The UI
 * uses this for the "Sell at date" modal in the account editor.
 */

import {
  calculateDepreciationRecapture, findCapitalGainsConfig, applyBrackets,
  annualResidentialDepreciation,
  type TaxConfigSet,
} from './tax-engine';

export interface SaleCalcInputs {
  account_type:           string;
  account_name:           string;
  current_balance:        number;
  rate_at_today:          number | null;
  config_json:            Record<string, unknown>;
  sale_date:              Date;
  /** Other federal taxable income for the year (used for LTCG stacking). */
  other_taxable_income:   number;
  /** Used to decide §121 eligibility for primary residences. */
  primary_residence_years_used: number;
}

export interface SaleCalculation {
  estimated_market_value:       number;
  cost_basis:                   number;
  total_gain:                   number;
  depreciation_recapture_gain:  number;
  capital_gain:                 number;
  estimated_recapture_tax:      number;
  estimated_capital_gains_tax:  number;
  section_121_exclusion:        number;
  estimated_net_proceeds:       number;
  assumptions:                  string[];
}

const SECTION_121_MFJ_EXCLUSION = 500000;

export function calculateSaleProceeds(
  inputs: SaleCalcInputs,
  taxConfig: TaxConfigSet,
): SaleCalculation {
  const assumptions: string[] = [];
  const today = new Date();
  const yearsForward = Math.max(0,
    (inputs.sale_date.getTime() - today.getTime()) / (365.25 * 86_400_000),
  );

  // 1. Market value: current balance compounded at the account's rate.
  const rate = inputs.rate_at_today ?? 0;
  const estimatedValue = inputs.current_balance * Math.pow(1 + rate, yearsForward);
  if (yearsForward > 0 && rate !== 0) {
    assumptions.push(`Projected value at ${(rate * 100).toFixed(2)}%/yr compounded for ${yearsForward.toFixed(1)} years`);
  }

  // 2. Cost basis + depreciation depend on type.
  let costBasis = inputs.current_balance;
  let accumulatedDepreciation = 0;

  if (inputs.account_type === 'real_estate_primary' || inputs.account_type === 'real_estate_investment') {
    const purchasePrice = Number(inputs.config_json.purchase_price ?? 0);
    const purchaseDate  = inputs.config_json.purchase_date as string | null | undefined;
    accumulatedDepreciation = Number(inputs.config_json.accumulated_depreciation ?? 0);

    if (inputs.account_type === 'real_estate_investment' && purchaseDate) {
      // Add years between today and sale_date to existing accumulated depreciation.
      const yearsHeld = Math.max(0,
        (inputs.sale_date.getTime() - new Date(`${purchaseDate}T00:00:00Z`).getTime()) /
        (365.25 * 86_400_000),
      );
      const annual = annualResidentialDepreciation(purchasePrice);
      // We approximate as-of-sale-date depreciation = annual × years held.
      accumulatedDepreciation = Math.max(accumulatedDepreciation, annual * yearsHeld);
      assumptions.push(`Accumulated depreciation ${formatCurrency(accumulatedDepreciation)} (27.5yr SL, 25% land)`);
    }

    costBasis = purchasePrice - accumulatedDepreciation;
  } else if (inputs.account_type === 'private_equity') {
    const shares = Number(inputs.config_json.shares_or_units ?? 0);
    const cbPer  = Number(inputs.config_json.cost_basis_per_share ?? 0);
    costBasis = shares * cbPer;
    if (cbPer > 0) {
      assumptions.push(`Cost basis: ${shares} units × $${cbPer.toFixed(2)} = ${formatCurrency(costBasis)}`);
    }
  }

  const totalGain = Math.max(0, estimatedValue - costBasis);

  // 3. Recapture (investment real estate only).
  let recaptureTax = 0;
  let recaptureGain = 0;
  let capitalGain = totalGain;
  if (inputs.account_type === 'real_estate_investment' && accumulatedDepreciation > 0) {
    const result = calculateDepreciationRecapture(
      estimatedValue,
      Number(inputs.config_json.purchase_price ?? 0),
      accumulatedDepreciation,
      taxConfig,
      inputs.sale_date.getUTCFullYear(),
      inputs.other_taxable_income,
    );
    recaptureTax  = result.recaptureTax;
    recaptureGain = result.recaptureGain;
    capitalGain   = result.capitalGain;
    assumptions.push(`Depreciation recapture taxed at 25%`);
  }

  // 4. §121 exclusion for a primary residence.
  let section121 = 0;
  if (inputs.account_type === 'real_estate_primary') {
    if (inputs.primary_residence_years_used >= 2) {
      section121 = Math.min(SECTION_121_MFJ_EXCLUSION, capitalGain);
      capitalGain -= section121;
      assumptions.push(`§121 exclusion applied: up to $500K MFJ (used as primary 2 of last 5 years)`);
    } else {
      assumptions.push(`§121 exclusion not available: must be primary residence 2 of last 5 years`);
    }
  }

  // 5. Federal LTCG tax on remaining capital gain.
  let ltcgTax = 0;
  if (capitalGain > 0) {
    const ltcgCfg = findCapitalGainsConfig(taxConfig, inputs.sale_date.getUTCFullYear(), 'federal');
    if (ltcgCfg?.ltcg_brackets) {
      ltcgTax = applyBrackets(capitalGain, ltcgCfg.ltcg_brackets, inputs.other_taxable_income);
    }
  }

  const netProceeds = estimatedValue - recaptureTax - ltcgTax;

  return {
    estimated_market_value:      round(estimatedValue),
    cost_basis:                  round(costBasis),
    total_gain:                  round(totalGain),
    depreciation_recapture_gain: round(recaptureGain),
    capital_gain:                round(capitalGain),
    estimated_recapture_tax:     round(recaptureTax),
    estimated_capital_gains_tax: round(ltcgTax),
    section_121_exclusion:       round(section121),
    estimated_net_proceeds:      round(netProceeds),
    assumptions,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
const formatCurrency = (n: number) =>
  `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
