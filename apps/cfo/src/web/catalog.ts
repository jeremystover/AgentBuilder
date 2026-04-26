// Static option lists for dropdowns. These mirror the const maps in
// apps/cfo/src/types.ts but are reproduced here so the SPA can consume
// them without importing worker code (the bundler would pull D1/Env
// types into the browser bundle).

export interface OptionEntity {
  slug: "elyse_coaching" | "jeremy_coaching" | "airbnb_activity" | "family_personal";
  label: string;
}

export const ENTITY_OPTIONS: OptionEntity[] = [
  { slug: "elyse_coaching",  label: "Elyse coaching" },
  { slug: "jeremy_coaching", label: "Jeremy coaching" },
  { slug: "airbnb_activity", label: "Whitford House" },
  { slug: "family_personal", label: "Family / personal" },
];

export interface OptionCategory {
  slug: string;
  label: string;
  kind: "tax" | "budget";
  group: "schedule_c" | "schedule_e" | "family";
}

const SCHEDULE_C: OptionCategory[] = [
  { slug: "income",                 label: "Gross receipts",            kind: "tax",    group: "schedule_c" },
  { slug: "advertising",            label: "Advertising",               kind: "tax",    group: "schedule_c" },
  { slug: "car_and_truck",          label: "Car and truck",             kind: "tax",    group: "schedule_c" },
  { slug: "commissions_and_fees",   label: "Commissions and fees",      kind: "tax",    group: "schedule_c" },
  { slug: "contract_labor",         label: "Contract labor",            kind: "tax",    group: "schedule_c" },
  { slug: "depreciation",           label: "Depreciation",              kind: "tax",    group: "schedule_c" },
  { slug: "insurance",              label: "Insurance",                 kind: "tax",    group: "schedule_c" },
  { slug: "interest_mortgage",      label: "Interest – mortgage",       kind: "tax",    group: "schedule_c" },
  { slug: "interest_other",         label: "Interest – other",          kind: "tax",    group: "schedule_c" },
  { slug: "legal_professional",     label: "Legal and professional",    kind: "tax",    group: "schedule_c" },
  { slug: "office_expense",         label: "Office expense",            kind: "tax",    group: "schedule_c" },
  { slug: "rent_lease_vehicle",     label: "Rent/lease – vehicle",      kind: "tax",    group: "schedule_c" },
  { slug: "rent_lease_property",    label: "Rent/lease – property",     kind: "tax",    group: "schedule_c" },
  { slug: "repairs_maintenance",    label: "Repairs/maintenance",       kind: "tax",    group: "schedule_c" },
  { slug: "supplies",               label: "Supplies",                  kind: "tax",    group: "schedule_c" },
  { slug: "taxes_licenses",         label: "Taxes/licenses",            kind: "tax",    group: "schedule_c" },
  { slug: "travel",                 label: "Travel",                    kind: "tax",    group: "schedule_c" },
  { slug: "meals",                  label: "Meals (50%)",               kind: "tax",    group: "schedule_c" },
  { slug: "utilities",              label: "Utilities",                 kind: "tax",    group: "schedule_c" },
  { slug: "wages",                  label: "Wages",                     kind: "tax",    group: "schedule_c" },
  { slug: "other_expenses",         label: "Other expenses",            kind: "tax",    group: "schedule_c" },
];

const SCHEDULE_E: OptionCategory[] = [
  { slug: "rental_income",          label: "Rental income",             kind: "tax",    group: "schedule_e" },
  { slug: "advertising_rental",     label: "Advertising (rental)",      kind: "tax",    group: "schedule_e" },
  { slug: "auto_travel",            label: "Auto and travel",           kind: "tax",    group: "schedule_e" },
  { slug: "cleaning_maintenance",   label: "Cleaning/maintenance",      kind: "tax",    group: "schedule_e" },
  { slug: "commissions",            label: "Commissions",               kind: "tax",    group: "schedule_e" },
  { slug: "insurance_rental",       label: "Insurance (rental)",        kind: "tax",    group: "schedule_e" },
  { slug: "legal_professional_r",   label: "Legal/professional (rental)", kind: "tax", group: "schedule_e" },
  { slug: "management_fees",        label: "Management fees",           kind: "tax",    group: "schedule_e" },
  { slug: "mortgage_interest",      label: "Mortgage interest",         kind: "tax",    group: "schedule_e" },
  { slug: "other_interest",         label: "Other interest",            kind: "tax",    group: "schedule_e" },
  { slug: "repairs_rental",         label: "Repairs (rental)",          kind: "tax",    group: "schedule_e" },
  { slug: "supplies_rental",        label: "Supplies (rental)",         kind: "tax",    group: "schedule_e" },
  { slug: "taxes_rental",           label: "Taxes (rental)",            kind: "tax",    group: "schedule_e" },
  { slug: "utilities_rental",       label: "Utilities (rental)",        kind: "tax",    group: "schedule_e" },
  { slug: "depreciation_rental",    label: "Depreciation (rental)",     kind: "tax",    group: "schedule_e" },
  { slug: "other_rental",           label: "Other (rental)",            kind: "tax",    group: "schedule_e" },
];

const FAMILY: OptionCategory[] = [
  { slug: "groceries",              label: "Groceries",                 kind: "budget", group: "family" },
  { slug: "dining_out",             label: "Dining out",                kind: "budget", group: "family" },
  { slug: "entertainment",          label: "Entertainment",             kind: "budget", group: "family" },
  { slug: "healthcare",             label: "Healthcare",                kind: "budget", group: "family" },
  { slug: "housing",                label: "Housing",                   kind: "budget", group: "family" },
  { slug: "transportation",         label: "Transportation",            kind: "budget", group: "family" },
  { slug: "education",              label: "Education",                 kind: "budget", group: "family" },
  { slug: "personal_care",          label: "Personal care",             kind: "budget", group: "family" },
  { slug: "shopping",               label: "Shopping",                  kind: "budget", group: "family" },
  { slug: "subscriptions",          label: "Subscriptions",             kind: "budget", group: "family" },
  { slug: "charitable_giving",      label: "Charitable giving",         kind: "budget", group: "family" },
  { slug: "potentially_deductible", label: "Potentially deductible",    kind: "budget", group: "family" },
  { slug: "other_personal",         label: "Other personal",            kind: "budget", group: "family" },
];

export const CATEGORY_OPTIONS: OptionCategory[] = [
  ...SCHEDULE_C, ...SCHEDULE_E, ...FAMILY,
];
