-- Seed the 2025 MFJ tax brackets used by the projection engine.
-- Numbers copied verbatim from docs/cfo-scenarios-supplemental-spec.md
-- Section: "Reference: Current Tax Law (2025, MFJ)".

-- Federal 2025 MFJ ordinary income brackets (7 brackets, std dedn $29,200).
INSERT INTO tax_bracket_schedules (year, filing_status, jurisdiction, brackets_json, standard_deduction)
VALUES (2025, 'married_filing_jointly', 'federal',
  '[
    {"floor":      0, "ceiling":  23200, "rate": 0.10},
    {"floor":  23200, "ceiling":  94300, "rate": 0.12},
    {"floor":  94300, "ceiling": 201050, "rate": 0.22},
    {"floor": 201050, "ceiling": 383900, "rate": 0.24},
    {"floor": 383900, "ceiling": 487450, "rate": 0.32},
    {"floor": 487450, "ceiling": 731200, "rate": 0.35},
    {"floor": 731200, "ceiling": null,   "rate": 0.37}
  ]'::jsonb,
  29200);

-- California 2025 MFJ ordinary income brackets (9 brackets + 1% Mental Health surcharge).
-- Note: the +1% mental-health surcharge above $1M is folded into the
-- top bracket (13.3% effective) for simplicity.
INSERT INTO tax_bracket_schedules (year, filing_status, jurisdiction, brackets_json, standard_deduction)
VALUES (2025, 'married_filing_jointly', 'CA',
  '[
    {"floor":       0, "ceiling":   20824, "rate": 0.010},
    {"floor":   20824, "ceiling":   49368, "rate": 0.020},
    {"floor":   49368, "ceiling":   77918, "rate": 0.040},
    {"floor":   77918, "ceiling":  108162, "rate": 0.060},
    {"floor":  108162, "ceiling":  136700, "rate": 0.080},
    {"floor":  136700, "ceiling":  698274, "rate": 0.093},
    {"floor":  698274, "ceiling":  837922, "rate": 0.103},
    {"floor":  837922, "ceiling": 1000000, "rate": 0.113},
    {"floor": 1000000, "ceiling": null,    "rate": 0.133}
  ]'::jsonb,
  10726);

-- Vermont 2025 MFJ ordinary income brackets (4 brackets; std dedn mirrors federal).
INSERT INTO tax_bracket_schedules (year, filing_status, jurisdiction, brackets_json, standard_deduction)
VALUES (2025, 'married_filing_jointly', 'VT',
  '[
    {"floor":       0, "ceiling":  72500, "rate": 0.0335},
    {"floor":   72500, "ceiling": 110000, "rate": 0.066},
    {"floor":  110000, "ceiling": 213150, "rate": 0.076},
    {"floor":  213150, "ceiling": null,   "rate": 0.0875}
  ]'::jsonb,
  29200);

-- Federal 2025 MFJ LTCG brackets (0% / 15% / 20%) + NIIT.
INSERT INTO capital_gains_config (year, jurisdiction, ltcg_brackets_json, niit_rate, niit_threshold, stcg_as_ordinary)
VALUES (2025, 'federal',
  '[
    {"floor":      0, "ceiling":  94050, "rate": 0.00},
    {"floor":  94050, "ceiling": 583750, "rate": 0.15},
    {"floor": 583750, "ceiling": null,   "rate": 0.20}
  ]'::jsonb,
  0.038, 250000, true);

-- State LTCG: both CA and VT effectively tax capital gains as ordinary
-- income (VT has a 40% exclusion on gains held >3 years; the basic
-- engine treats both as ordinary at the state level and refines later).
INSERT INTO capital_gains_config (year, jurisdiction, ltcg_brackets_json, niit_rate, niit_threshold, stcg_as_ordinary)
VALUES (2025, 'CA', NULL, 0.0, 0, true);

INSERT INTO capital_gains_config (year, jurisdiction, ltcg_brackets_json, niit_rate, niit_threshold, stcg_as_ordinary)
VALUES (2025, 'VT', NULL, 0.0, 0, true);
