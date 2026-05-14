-- Seed Schedule C / Schedule E / personal budget categories. Slugs are
-- stable identifiers used by rules and AI classification. form_line stores
-- the IRS line for tax categories and stays NULL for budget categories.
-- Descriptions are read by the AI classifier when assigning categories.

-- =============================================
-- SCHEDULE C — Sole proprietor (Elyse + Jeremy coaching)
-- =============================================

INSERT INTO categories (id, name, slug, entity_type, category_set, form_line, description, sort_order) VALUES
  -- Part I (Income)
  ('cat_sc_gross_receipts', 'Gross receipts',           'sc_gross_receipts',     'schedule_c', 'schedule_c', 'Part I Line 1',  'Coaching client revenue, course payments, speaking fees', 10),
  ('cat_sc_returns',        'Returns and allowances',   'sc_returns',            'schedule_c', 'schedule_c', 'Part I Line 2',  'Refunds issued to clients', 20),

  -- Part II (Expenses)
  ('cat_sc_advertising',    'Advertising',              'sc_advertising',        'schedule_c', 'schedule_c', 'Part II Line 8',  'Ads, promotional content, paid search/social', 100),
  ('cat_sc_car',            'Car and truck expenses',   'sc_car',                'schedule_c', 'schedule_c', 'Part II Line 9',  'Mileage, fuel, parking, tolls, vehicle maintenance for business use', 110),
  ('cat_sc_commissions',    'Commissions and fees',     'sc_commissions',        'schedule_c', 'schedule_c', 'Part II Line 10', 'Affiliate payouts, platform commissions, referral fees', 120),
  ('cat_sc_contract',       'Contract labor',           'sc_contract',           'schedule_c', 'schedule_c', 'Part II Line 11', 'Payments to non-employee contractors (1099)', 130),
  ('cat_sc_depreciation',   'Depreciation',             'sc_depreciation',       'schedule_c', 'schedule_c', 'Part II Line 13', 'Section 179, equipment depreciation', 140),
  ('cat_sc_insurance',      'Insurance (other than health)', 'sc_insurance',     'schedule_c', 'schedule_c', 'Part II Line 15', 'Business liability, E&O, professional', 150),
  ('cat_sc_interest',       'Interest',                 'sc_interest',           'schedule_c', 'schedule_c', 'Part II Line 16', 'Business loan or credit card interest', 160),
  ('cat_sc_legal',          'Legal and professional',   'sc_legal',              'schedule_c', 'schedule_c', 'Part II Line 17', 'Legal counsel, accountants, bookkeepers', 170),
  ('cat_sc_office',         'Office expense',           'sc_office',             'schedule_c', 'schedule_c', 'Part II Line 18', 'Office supplies, printing, postage', 180),
  ('cat_sc_pension',        'Pension and profit-sharing', 'sc_pension',          'schedule_c', 'schedule_c', 'Part II Line 19', 'Solo 401(k) employer match, SEP IRA contribs (employer share)', 190),
  ('cat_sc_rent_vehicle',   'Rent — vehicles/equipment','sc_rent_vehicle',       'schedule_c', 'schedule_c', 'Part II Line 20a','Equipment rental, vehicle leases for business', 200),
  ('cat_sc_rent_other',     'Rent — other property',    'sc_rent_other',         'schedule_c', 'schedule_c', 'Part II Line 20b','Office rent, coworking memberships', 210),
  ('cat_sc_repairs',        'Repairs and maintenance',  'sc_repairs',            'schedule_c', 'schedule_c', 'Part II Line 21', 'Equipment repair, software upkeep', 220),
  ('cat_sc_supplies',       'Supplies',                 'sc_supplies',           'schedule_c', 'schedule_c', 'Part II Line 22', 'Consumable supplies (not capitalized)', 230),
  ('cat_sc_taxes',          'Taxes and licenses',       'sc_taxes',              'schedule_c', 'schedule_c', 'Part II Line 23', 'State/local business taxes, professional licenses', 240),
  ('cat_sc_travel',         'Travel',                   'sc_travel',             'schedule_c', 'schedule_c', 'Part II Line 24a','Airfare, lodging, ground transport for business', 250),
  ('cat_sc_meals',          'Meals',                    'sc_meals',              'schedule_c', 'schedule_c', 'Part II Line 24b','Business meals (50% deductible)', 260),
  ('cat_sc_utilities',      'Utilities',                'sc_utilities',          'schedule_c', 'schedule_c', 'Part II Line 25', 'Phone (business portion), internet (business portion)', 270),
  ('cat_sc_wages',          'Wages',                    'sc_wages',              'schedule_c', 'schedule_c', 'Part II Line 26', 'W-2 employee wages (less employment credits)', 280),
  ('cat_sc_other',          'Other expenses',           'sc_other',              'schedule_c', 'schedule_c', 'Part II Line 27a','Software subscriptions, training, books not classified above', 290),
  ('cat_sc_home_office',    'Home office (Form 8829)',  'sc_home_office',        'schedule_c', 'schedule_c', 'Part II Line 30', 'Home office expense (computed via Form 8829)', 300);

-- =============================================
-- SCHEDULE E — Rental real estate (Whitford House)
-- =============================================

INSERT INTO categories (id, name, slug, entity_type, category_set, form_line, description, sort_order) VALUES
  -- Income
  ('cat_se_rents',           'Rents received',          'se_rents',              'schedule_e', 'schedule_e', 'Part I Line 3a', 'Tenant rent payments', 10),
  ('cat_se_royalties',       'Royalties received',      'se_royalties',          'schedule_e', 'schedule_e', 'Part I Line 4',  'Mineral, copyright, patent royalties', 20),

  -- Expenses
  ('cat_se_advertising',     'Advertising',             'se_advertising',        'schedule_e', 'schedule_e', 'Part I Line 5',  'Listing fees, signage, tenant acquisition', 100),
  ('cat_se_auto_travel',     'Auto and travel',         'se_auto_travel',        'schedule_e', 'schedule_e', 'Part I Line 6',  'Mileage and travel for property visits', 110),
  ('cat_se_cleaning',        'Cleaning and maintenance','se_cleaning',           'schedule_e', 'schedule_e', 'Part I Line 7',  'Recurring cleaning, landscaping, pest control', 120),
  ('cat_se_commissions',     'Commissions',             'se_commissions',        'schedule_e', 'schedule_e', 'Part I Line 8',  'Property management commissions, leasing fees', 130),
  ('cat_se_insurance',       'Insurance',               'se_insurance',          'schedule_e', 'schedule_e', 'Part I Line 9',  'Hazard, liability, umbrella insurance', 140),
  ('cat_se_legal',           'Legal and professional',  'se_legal',              'schedule_e', 'schedule_e', 'Part I Line 10', 'Eviction counsel, accountants for the property', 150),
  ('cat_se_management',      'Management fees',         'se_management',         'schedule_e', 'schedule_e', 'Part I Line 11', 'Ongoing PM fees', 160),
  ('cat_se_mortgage_interest','Mortgage interest',      'se_mortgage_interest',  'schedule_e', 'schedule_e', 'Part I Line 12', 'Interest paid to banks (Form 1098)', 170),
  ('cat_se_other_interest',  'Other interest',          'se_other_interest',     'schedule_e', 'schedule_e', 'Part I Line 13', 'Non-bank interest (e.g. seller financing)', 180),
  ('cat_se_repairs',         'Repairs',                 'se_repairs',            'schedule_e', 'schedule_e', 'Part I Line 14', 'Non-capitalizable repairs (paint, drywall, plumbing fixes)', 190),
  ('cat_se_supplies',        'Supplies',                'se_supplies',           'schedule_e', 'schedule_e', 'Part I Line 15', 'Consumable supplies for the property', 200),
  ('cat_se_taxes',           'Taxes',                   'se_taxes',              'schedule_e', 'schedule_e', 'Part I Line 16', 'Property tax, local assessments', 210),
  ('cat_se_utilities',       'Utilities',               'se_utilities',          'schedule_e', 'schedule_e', 'Part I Line 17', 'Property-paid water/sewer/electric/gas/internet', 220),
  ('cat_se_depreciation',    'Depreciation',            'se_depreciation',       'schedule_e', 'schedule_e', 'Part I Line 18', 'Annual depreciation expense', 230),
  ('cat_se_other',           'Other expenses',          'se_other',              'schedule_e', 'schedule_e', 'Part I Line 19', 'HOA fees, lockbox, software, anything not categorized above', 240);

-- =============================================
-- BUDGET — Personal/Family
-- =============================================

INSERT INTO categories (id, name, slug, entity_type, category_set, form_line, description, sort_order) VALUES
  ('cat_b_groceries',        'Groceries',               'b_groceries',           'personal',   'budget',     NULL, 'Supermarkets, food markets, butchers', 100),
  ('cat_b_dining',           'Dining out',              'b_dining',              'personal',   'budget',     NULL, 'Restaurants, takeout, coffee, bars', 110),
  ('cat_b_housing',          'Housing',                 'b_housing',             'personal',   'budget',     NULL, 'Mortgage/rent, primary residence repairs, household goods', 120),
  ('cat_b_utilities',        'Utilities',               'b_utilities',           'personal',   'budget',     NULL, 'Electric, gas, water, internet, phone for the family home', 130),
  ('cat_b_transport',        'Transportation',          'b_transport',           'personal',   'budget',     NULL, 'Personal car, gas, insurance, transit, ride-share', 140),
  ('cat_b_health',           'Health and medical',      'b_health',              'personal',   'budget',     NULL, 'Doctors, dentists, prescriptions, health insurance premiums', 150),
  ('cat_b_kids',             'Kids',                    'b_kids',                'personal',   'budget',     NULL, 'Childcare, school fees, kid activities, kid clothing', 160),
  ('cat_b_pets',             'Pets',                    'b_pets',                'personal',   'budget',     NULL, 'Vet, food, grooming, pet sitting', 170),
  ('cat_b_clothing',         'Clothing',                'b_clothing',            'personal',   'budget',     NULL, 'Clothing and footwear for adults', 180),
  ('cat_b_personal_care',    'Personal care',           'b_personal_care',       'personal',   'budget',     NULL, 'Haircuts, salon, gym, wellness', 190),
  ('cat_b_entertainment',    'Entertainment',           'b_entertainment',       'personal',   'budget',     NULL, 'Streaming, music, books, movies, hobbies', 200),
  ('cat_b_travel',           'Travel and vacations',    'b_travel',              'personal',   'budget',     NULL, 'Family trips, leisure travel, lodging, flights for non-business', 210),
  ('cat_b_gifts',            'Gifts and donations',     'b_gifts',               'personal',   'budget',     NULL, 'Birthday/holiday gifts, charitable contributions', 220),
  ('cat_b_savings',          'Savings and investments', 'b_savings',             'personal',   'budget',     NULL, 'Brokerage transfers, IRA contributions (personal share), HSA', 230),
  ('cat_b_misc',             'Miscellaneous',           'b_misc',                'personal',   'budget',     NULL, 'Anything not classified above', 900);

-- =============================================
-- TRANSFER (special — applies to all entities)
-- =============================================

INSERT INTO categories (id, name, slug, entity_type, category_set, description, sort_order) VALUES
  ('cat_transfer',           'Transfer',                'transfer',              'all',        'custom',     'Internal transfer between owned accounts; not income or expense', 9999);
