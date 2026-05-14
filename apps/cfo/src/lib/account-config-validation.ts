/**
 * Per-type schema for `account_type_config.config_json`.
 *
 * The supplemental spec documents one JSON shape per account type. We
 * check the required fields are present and the right primitive shape;
 * we deliberately don't enforce non-required fields so the UI can save
 * partial drafts as the user fills in the form.
 *
 * Mirrors docs/cfo-scenarios-supplemental-spec.md Phase 1, "Type-Specific
 * Config JSON Schemas".
 */

export type AccountType =
  | 'checking'
  | 'brokerage'
  | 'trad_401k'
  | 'roth_ira'
  | 'real_estate_primary'
  | 'real_estate_investment'
  | 'mortgage'
  | 'heloc'
  | 'loan'
  | 'private_equity'
  | '529'
  | 'social_security'
  | 'other_asset'
  | 'other_liability';

export const ASSET_TYPES: AccountType[] = [
  'checking', 'brokerage', 'trad_401k', 'roth_ira',
  'real_estate_primary', 'real_estate_investment',
  'private_equity', '529', 'social_security', 'other_asset',
];

export const LIABILITY_TYPES: AccountType[] = [
  'mortgage', 'heloc', 'loan', 'other_liability',
];

interface FieldSpec {
  required: boolean;
  type: 'string' | 'number' | 'boolean' | 'array';
  enum?: string[];
}

const SCHEMAS: Record<AccountType, Record<string, FieldSpec>> = {
  checking: {},
  brokerage: {
    tax_lots: { required: false, type: 'array' },
  },
  trad_401k: {
    owner:                { required: true,  type: 'string', enum: ['jeremy', 'elyse'] },
    account_subtype:      { required: false, type: 'string' },
    annual_contribution:  { required: false, type: 'number' },
  },
  roth_ira: {
    owner:                   { required: true,  type: 'string', enum: ['jeremy', 'elyse'] },
    account_subtype:         { required: false, type: 'string' },
    roth_contribution_basis: { required: false, type: 'number' },
    annual_contribution:     { required: false, type: 'number' },
  },
  real_estate_primary: {
    purchase_price:           { required: true,  type: 'number' },
    purchase_date:            { required: true,  type: 'string' },
    is_primary_residence:     { required: false, type: 'boolean' },
    accumulated_depreciation: { required: false, type: 'number' },
  },
  real_estate_investment: {
    purchase_price:           { required: true,  type: 'number' },
    purchase_date:            { required: true,  type: 'string' },
    is_primary_residence:     { required: false, type: 'boolean' },
    accumulated_depreciation: { required: false, type: 'number' },
  },
  mortgage: {
    original_principal: { required: true,  type: 'number' },
    origination_date:   { required: true,  type: 'string' },
    term_months:        { required: true,  type: 'number' },
    current_principal:  { required: true,  type: 'number' },
    monthly_payment:    { required: true,  type: 'number' },
  },
  heloc: {
    current_principal: { required: true, type: 'number' },
    monthly_payment:   { required: false, type: 'number' },
  },
  loan: {
    current_principal: { required: true, type: 'number' },
    monthly_payment:   { required: false, type: 'number' },
  },
  private_equity: {
    company:              { required: true,  type: 'string' },
    grant_type:           { required: true,  type: 'string', enum: ['ISO', 'NSO', 'RSU', 'common'] },
    shares_or_units:      { required: true,  type: 'number' },
    cost_basis_per_share: { required: false, type: 'number' },
    vesting_schedule:     { required: false, type: 'array' },
    liquidity_events:     { required: false, type: 'array' },
  },
  '529': {
    owner:               { required: true,  type: 'string', enum: ['jeremy', 'elyse'] },
    beneficiary:         { required: true,  type: 'string' },
    annual_contribution: { required: false, type: 'number' },
    withdrawal_schedule: { required: false, type: 'array' },
  },
  social_security: {
    person:              { required: true,  type: 'string', enum: ['jeremy', 'elyse'] },
    fra_monthly_benefit: { required: true,  type: 'number' },
    full_retirement_age: { required: true,  type: 'number' },
    elected_start_age:   { required: true,  type: 'number' },
  },
  other_asset:     {},
  other_liability: {},
};

export interface ValidationError {
  field: string;
  message: string;
}

export function validateAccountTypeConfig(
  type: AccountType,
  config: unknown,
): ValidationError[] {
  const schema = SCHEMAS[type];
  if (!schema) return [{ field: 'type', message: `Unknown account type: ${type}` }];
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return [{ field: 'config', message: 'config_json must be an object' }];
  }
  const errors: ValidationError[] = [];
  const obj = config as Record<string, unknown>;
  for (const [field, spec] of Object.entries(schema)) {
    const value = obj[field];
    const missing = value === undefined || value === null || value === '';
    if (spec.required && missing) {
      errors.push({ field, message: `${field} is required` });
      continue;
    }
    if (missing) continue;
    if (spec.type === 'array') {
      if (!Array.isArray(value)) errors.push({ field, message: `${field} must be an array` });
    } else if (spec.type === 'number') {
      if (typeof value !== 'number' || !isFinite(value)) errors.push({ field, message: `${field} must be a number` });
    } else if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') errors.push({ field, message: `${field} must be a boolean` });
    } else if (spec.type === 'string') {
      if (typeof value !== 'string') errors.push({ field, message: `${field} must be a string` });
      else if (spec.enum && !spec.enum.includes(value)) {
        errors.push({ field, message: `${field} must be one of ${spec.enum.join(', ')}` });
      }
    }
  }
  return errors;
}

export function inferAssetOrLiability(type: AccountType): 'asset' | 'liability' {
  return LIABILITY_TYPES.includes(type) ? 'liability' : 'asset';
}
