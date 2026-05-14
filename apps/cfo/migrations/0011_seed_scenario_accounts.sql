-- Pre-seed Jeremy's household accounts so the editor isn't a blank page.
-- All balances are 0 — real values get filled in via the UI.
-- Reference: docs/cfo-scenarios-supplemental-spec.md "This Household's Accounts".

INSERT INTO scenario_accounts (id, name, type, asset_or_liability, entity_id, current_balance, notes) VALUES
  ('sa_checking',          'Checking (primary)',         'checking',               'asset',     'ent_personal', 0, 'Liquid operating account'),
  ('sa_savings',           'Savings',                    'checking',               'asset',     'ent_personal', 0, 'Emergency reserve'),
  ('sa_gong_401k',         'Gong 401(k)',                'trad_401k',              'asset',     'ent_personal', 0, 'Traditional pre-tax'),
  ('sa_roth_ira',          'Roth IRA',                   'roth_ira',               'asset',     'ent_personal', 0, NULL),
  ('sa_taxable',           'Taxable Brokerage',          'brokerage',              'asset',     'ent_personal', 0, NULL),
  ('sa_gong_equity',       'Gong equity',                'private_equity',         'asset',     'ent_personal', 0, 'ISO grants; strike ~$1.25'),
  ('sa_ripple',            'Ripple stake',               'private_equity',         'asset',     'ent_personal', 0, 'XRP shareholder equity'),
  ('sa_whitford_house',    'Whitford House',             'real_estate_investment', 'asset',     'ent_whitford', 0, '912 Grandey Rd, Addison VT'),
  ('sa_sf_home',           'SF Home',                    'real_estate_primary',    'asset',     'ent_personal', 0, 'Sunnyside, SF'),
  ('sa_sf_mortgage',       'SF Mortgage',                'mortgage',               'liability', 'ent_personal', 0, 'On SF home'),
  ('sa_whitford_mortgage', 'Whitford House Mortgage',    'mortgage',               'liability', 'ent_whitford', 0, NULL),
  ('sa_529_daughter',      '529 — Daughter',             '529',                    'asset',     'ent_personal', 0, NULL),
  ('sa_529_son',           '529 — Son',                  '529',                    'asset',     'ent_personal', 0, NULL),
  ('sa_ss_jeremy',         'SS — Jeremy',                'social_security',        'asset',     'ent_personal', 0, 'FRA benefit TBD'),
  ('sa_ss_elyse',          'SS — Elyse',                 'social_security',        'asset',     'ent_personal', 0, 'FRA benefit TBD');

-- Seed minimal type_config rows so the editor has something to update
-- without an INSERT-then-UPDATE on first save.
INSERT INTO account_type_config (account_id, config_json) VALUES
  ('sa_gong_401k',         '{"owner": "jeremy", "account_subtype": "traditional_401k"}'),
  ('sa_roth_ira',          '{"owner": "jeremy", "account_subtype": "roth_ira", "roth_contribution_basis": 0}'),
  ('sa_taxable',           '{"tax_lots": []}'),
  ('sa_gong_equity',       '{"company": "Gong", "grant_type": "ISO", "shares_or_units": 0, "cost_basis_per_share": 1.25, "vesting_schedule": [], "liquidity_events": []}'),
  ('sa_ripple',            '{"company": "Ripple", "grant_type": "common", "shares_or_units": 0, "vesting_schedule": [], "liquidity_events": []}'),
  ('sa_whitford_house',    '{"purchase_price": 0, "purchase_date": null, "is_primary_residence": false, "accumulated_depreciation": 0}'),
  ('sa_sf_home',           '{"purchase_price": 0, "purchase_date": null, "is_primary_residence": true,  "accumulated_depreciation": 0}'),
  ('sa_sf_mortgage',       '{"original_principal": 0, "origination_date": null, "term_months": 360, "current_principal": 0, "monthly_payment": 0}'),
  ('sa_whitford_mortgage', '{"original_principal": 0, "origination_date": null, "term_months": 360, "current_principal": 0, "monthly_payment": 0}'),
  ('sa_529_daughter',      '{"owner": "jeremy", "beneficiary": "daughter", "annual_contribution": 0, "withdrawal_schedule": []}'),
  ('sa_529_son',           '{"owner": "jeremy", "beneficiary": "son", "annual_contribution": 0, "withdrawal_schedule": []}'),
  ('sa_ss_jeremy',         '{"person": "jeremy", "fra_monthly_benefit": 0, "full_retirement_age": 67, "elected_start_age": 67}'),
  ('sa_ss_elyse',          '{"person": "elyse",  "fra_monthly_benefit": 0, "full_retirement_age": 67, "elected_start_age": 67}');
