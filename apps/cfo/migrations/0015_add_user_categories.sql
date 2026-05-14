-- Add custom user categories on top of the seed set. These reflect how
-- the user actually categorizes their spending; the auto-mapper in
-- scripts/migrate-data-from-d1.ts knows about them so old D1 slugs
-- map cleanly.

INSERT INTO categories (id, name, slug, entity_type, category_set, form_line, description, sort_order) VALUES
  ('cat_sc_development',     'Professional development', 'sc_development',     'schedule_c', 'schedule_c', 'Part II Line 27a', 'Courses, conferences, training, business books (rolls up under Other on Schedule C)', 295),
  ('cat_se_furnishings',     'Furnishings',              'se_furnishings',     'schedule_e', 'custom',     NULL,               'Furniture and equipment purchased for the rental (tracking only; deducted over time via depreciation)', 700),
  ('cat_se_capimprovements', 'Capital improvements',     'se_capimprovements', 'schedule_e', 'custom',     NULL,               'Capitalized improvements (roof, HVAC, etc.) — tracking only; deducted over the asset life via depreciation', 710),
  ('cat_b_insurance',        'Insurance (personal)',     'b_insurance',        'personal',   'budget',     NULL,               'Personal insurance premiums (life, auto, umbrella)', 145),
  ('cat_b_repairs',          'Home repairs',             'b_repairs',          'personal',   'budget',     NULL,               'Repairs and maintenance on the primary residence', 125),
  ('cat_b_capgains',         'Capital gains',            'b_capgains',         'personal',   'budget',     NULL,               'Realized capital gains (income tracking)', 235);
