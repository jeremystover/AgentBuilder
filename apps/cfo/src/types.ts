/**
 * Env for the CFO worker. Dropped Plaid bindings on migration from
 * tax-prep — Teller is the only bank provider now. MCP_HTTP_KEY gates
 * the /mcp JSON-RPC surface (unset => open, dev only).
 */
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  TELLER_APPLICATION_ID?: string;
  TELLER_ENV?: string;
  TELLER_MTLS?: Fetcher;
  DEFAULT_BANK_PROVIDER?: string;
  ANTHROPIC_API_KEY: string;
  MCP_HTTP_KEY?: string;
}

export type BankProvider = 'teller';

export type Entity = 'coaching_business' | 'airbnb_activity' | 'family_personal';
export type ClassificationMethod = 'rule' | 'ai' | 'manual' | 'historical';
export type ReviewReason = 'low_confidence' | 'no_match' | 'conflict' | 'flagged' | 'unclassified';

export interface Transaction {
  id: string;
  user_id: string;
  account_id: string | null;
  import_id: string | null;
  plaid_transaction_id: string | null;
  teller_transaction_id: string | null;
  posted_date: string;
  amount: number;
  currency: string;
  merchant_name: string | null;
  description: string;
  description_clean: string | null;
  category_plaid: string | null;
  is_pending: number;
  dedup_hash: string | null;
  created_at: string;
}

export interface Classification {
  id: string;
  transaction_id: string;
  business_entity_id: string | null;
  chart_of_account_id: string | null;
  entity: Entity | null;
  category_tax: string | null;
  category_budget: string | null;
  confidence: number | null;
  method: ClassificationMethod | null;
  reason_codes: string | null;
  review_required: number;
  is_locked: number;
  classified_at: string;
  classified_by: string;
}

export interface Account {
  id: string;
  plaid_item_id: string | null;
  teller_enrollment_id: string | null;
  user_id: string;
  plaid_account_id: string | null;
  teller_account_id: string | null;
  name: string;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  owner_tag: string | null;
  is_active: number;
  created_at: string;
}

export interface Rule {
  id: string;
  user_id: string;
  name: string;
  match_field: 'merchant_name' | 'description' | 'account_id' | 'amount';
  match_operator: 'contains' | 'equals' | 'starts_with' | 'ends_with' | 'regex';
  match_value: string;
  entity: Entity;
  category_tax: string | null;
  category_budget: string | null;
  priority: number;
  is_active: number;
  created_at: string;
}

export interface AIClassification {
  entity: Entity;
  category_tax: string;
  category_budget: string;
  confidence: number;
  reason_codes: string[];
  review_required: boolean;
}

export interface AmazonOrder {
  id: string;
  user_id: string;
  import_id: string;
  order_key: string;
  order_id: string | null;
  order_date: string | null;
  shipment_date: string | null;
  total_amount: number;
  quantity_total: number;
  product_names: string;
  seller_names: string | null;
  order_status: string | null;
  payment_instrument_type: string | null;
  ship_to: string | null;
  shipping_address: string | null;
  created_at: string;
}

export interface AmazonContext {
  order_id: string | null;
  order_date: string | null;
  shipment_date: string | null;
  total_amount: number;
  product_names: string[];
  seller_names: string[];
  ship_to: string | null;
  shipping_address: string | null;
  inferred_destination: 'whitford_house' | 'family_home' | null;
}

export interface BusinessEntity {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  entity_type: string;
  tax_year: number | null;
  created_at: string;
}

export interface ChartOfAccount {
  id: string;
  business_entity_id: string;
  code: string;
  name: string;
  form_line: string | null;
  category_type: string;
  is_deductible: number;
}

// ── Schedule C categories (coaching business) ────────────────────────────────
export const SCHEDULE_C_CATEGORIES: Record<string, { name: string; form_line: string }> = {
  income:                 { name: 'Gross receipts / income',         form_line: 'Line 1'   },
  advertising:            { name: 'Advertising',                      form_line: 'Line 8'   },
  car_and_truck:          { name: 'Car and truck expenses',           form_line: 'Line 9'   },
  commissions_and_fees:   { name: 'Commissions and fees',             form_line: 'Line 10'  },
  contract_labor:         { name: 'Contract labor',                   form_line: 'Line 11'  },
  depreciation:           { name: 'Depreciation',                     form_line: 'Line 13'  },
  insurance:              { name: 'Insurance (other than health)',     form_line: 'Line 15'  },
  interest_mortgage:      { name: 'Interest – mortgage',              form_line: 'Line 16a' },
  interest_other:         { name: 'Interest – other',                 form_line: 'Line 16b' },
  legal_professional:     { name: 'Legal and professional services',  form_line: 'Line 17'  },
  office_expense:         { name: 'Office expense',                   form_line: 'Line 18'  },
  rent_lease_vehicle:     { name: 'Rent or lease – vehicles',        form_line: 'Line 20a' },
  rent_lease_property:    { name: 'Rent or lease – other property',  form_line: 'Line 20b' },
  repairs_maintenance:    { name: 'Repairs and maintenance',          form_line: 'Line 21'  },
  supplies:               { name: 'Supplies',                         form_line: 'Line 22'  },
  taxes_licenses:         { name: 'Taxes and licenses',               form_line: 'Line 23'  },
  travel:                 { name: 'Travel',                           form_line: 'Line 24a' },
  meals:                  { name: 'Meals (50% deductible)',           form_line: 'Line 24b' },
  utilities:              { name: 'Utilities',                        form_line: 'Line 25'  },
  wages:                  { name: 'Wages',                            form_line: 'Line 26'  },
  other_expenses:         { name: 'Other expenses',                   form_line: 'Line 27'  },
};

// ── Whitford House / Schedule E categories ──────────────────────────────────
export const AIRBNB_CATEGORIES: Record<string, { name: string; form_line: string }> = {
  rental_income:          { name: 'Rental income',                   form_line: 'Line 3'  },
  advertising_rental:     { name: 'Advertising',                     form_line: 'Line 5'  },
  auto_travel:            { name: 'Auto and travel',                  form_line: 'Line 6'  },
  cleaning_maintenance:   { name: 'Cleaning and maintenance',         form_line: 'Line 7'  },
  commissions:            { name: 'Commissions (platform fees)',      form_line: 'Line 8'  },
  insurance_rental:       { name: 'Insurance',                        form_line: 'Line 9'  },
  legal_professional_r:   { name: 'Legal and professional',           form_line: 'Line 10' },
  management_fees:        { name: 'Management fees',                  form_line: 'Line 11' },
  mortgage_interest:      { name: 'Mortgage interest',               form_line: 'Line 12' },
  other_interest:         { name: 'Other interest',                  form_line: 'Line 13' },
  repairs_rental:         { name: 'Repairs',                          form_line: 'Line 14' },
  supplies_rental:        { name: 'Supplies',                         form_line: 'Line 15' },
  taxes_rental:           { name: 'Taxes',                            form_line: 'Line 16' },
  utilities_rental:       { name: 'Utilities',                        form_line: 'Line 17' },
  depreciation_rental:    { name: 'Depreciation',                     form_line: 'Line 18' },
  other_rental:           { name: 'Other expenses',                   form_line: 'Line 19' },
};

// ── Family / personal categories ────────────────────────────────────────────
export const FAMILY_CATEGORIES: Record<string, string> = {
  groceries:              'Groceries',
  dining_out:             'Dining out',
  entertainment:          'Entertainment',
  healthcare:             'Healthcare',
  housing:                'Housing',
  transportation:         'Transportation',
  education:              'Education',
  personal_care:          'Personal care',
  shopping:               'Shopping',
  subscriptions:          'Subscriptions',
  charitable_giving:      'Charitable giving',
  potentially_deductible: 'Potentially deductible',
  other_personal:         'Other personal',
};

// ── Helpers ──────────────────────────────────────────────────────────────────
export function jsonOk(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export function getUserId(request: Request): string {
  return request.headers.get('x-user-id') ?? 'default';
}
