# Build Prompt — Phase 2: Reporting Module

**Session goal:** Build Module 6 (Reporting) — saved report configurations, report generation, Google Sheets output to Google Drive, and run history.

**Before writing any code:** Read `apps/cfo/CLAUDE.md`. Read `apps/cfo/src/web/components/drilldowns/ReportsView.tsx` — you will be adapting the IRS-line table layout. Also read the Module 6 section in `docs/family-finance-spec.md`.

**All of Phase 1 must be complete before starting this session.**

---

## What Phase 2 Builds

- Report configurations (saved, reusable templates with entity + category filters)
- Report generation: query approved transactions, group by IRS line or budget category
- Output to Google Sheets pushed to Google Drive
- Run history with Drive links and unreviewed-transaction warning
- `ReportsView` UI in the SPA
- Two MCP tools for reporting

---

## Step 1: Database additions

Create `migrations/0003_reporting.sql`:

```sql
CREATE TABLE report_configs (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name              TEXT NOT NULL,
  entity_ids        TEXT[] NOT NULL DEFAULT '{}',
  category_ids      TEXT[] NOT NULL DEFAULT '{}',
  category_mode     TEXT NOT NULL DEFAULT 'all'
                    CHECK (category_mode IN ('tax', 'budget', 'all')),
  include_transactions BOOLEAN NOT NULL DEFAULT true,
  drive_folder_id   TEXT,
  notes             TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO report_configs (id, name, entity_ids, category_mode, notes) VALUES
  ('rc_schedule_c_elyse',    'Elyse Coaching — Schedule C',   ARRAY['ent_elyse_coaching'],  'tax',    'Schedule C for Elyse coaching business.'),
  ('rc_schedule_c_jeremy',   'Jeremy Coaching — Schedule C',  ARRAY['ent_jeremy_coaching'], 'tax',    'Schedule C for Jeremy coaching business.'),
  ('rc_schedule_e_whitford', 'Whitford House — Schedule E',   ARRAY['ent_whitford'],        'tax',    'Schedule E for Whitford House rental property.'),
  ('rc_family_annual',       'Family Annual Summary',          ARRAY[]::text[],              'budget', 'All entities, budget categories.');

CREATE TABLE report_runs (
  id                        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  config_id                 TEXT NOT NULL REFERENCES report_configs(id),
  date_from                 DATE NOT NULL,
  date_to                   DATE NOT NULL,
  generated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  drive_link                TEXT,
  file_name                 TEXT,
  status                    TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  error_message             TEXT,
  transaction_count         INTEGER,
  unreviewed_warning_count  INTEGER DEFAULT 0
);
```

---

## Step 2: IRS line mappings

When seeding categories in `migrations/0002_seed_categories.sql`, include `form_line` values for all tax categories. Key Schedule C Part II lines:

| form_line | name |
|---|---|
| Part II Line 8 | Advertising |
| Part II Line 11 | Contract labor |
| Part II Line 15 | Insurance (other than health) |
| Part II Line 17 | Legal and professional services |
| Part II Line 18 | Office expense |
| Part II Line 21 | Repairs and maintenance |
| Part II Line 22 | Supplies |
| Part II Line 24 | Travel and meals |
| Part II Line 25 | Utilities |
| Part II Line 27 | Other expenses |
| Part I Line 1 | Gross receipts / sales |

Key Schedule E Part I lines (Whitford House):

| form_line | name |
|---|---|
| Line 3 | Rents received |
| Line 9 | Insurance |
| Line 12 | Mortgage interest paid to banks |
| Line 14 | Repairs |
| Line 15 | Supplies |
| Line 16 | Taxes |
| Line 17 | Utilities |
| Line 19 | Other expenses |

---

## Step 3: Report generation logic

Create `src/lib/report-generator.ts`.

For a given config + date range:
1. Query `transactions` where `status = 'approved'`, `date BETWEEN date_from AND date_to`
2. Filter by entity_ids and category_mode per the config
3. Count unreviewed transactions in the same date range (for the warning)
4. Group transactions by category
5. For tax configs: sort categories by `form_line`; group into Income and Expense sections
6. For budget configs: sort by category name; group by entity

Output shape:
```typescript
interface ReportOutput {
  title: string;
  date_range: { from: string; to: string };
  generated_at: string;
  entity_names: string[];
  unreviewed_warning_count: number;
  sections: Array<{
    section_name: string;
    lines: Array<{
      line_number: string;
      label: string;
      total: number;
      transactions?: Array<{ date: string; description: string; amount: number }>;
    }>;
    section_total: number;
  }>;
  net_total: number;
}
```

---

## Step 4: Google Sheets output

Create `src/lib/google-sheets.ts`.

Auth: `@agentbuilder/auth-google` with scopes `spreadsheets` and `drive.file`.

Steps:
1. `POST https://sheets.googleapis.com/v4/spreadsheets` — create spreadsheet with sheets: Summary, By Month (if range > 1 month), Transactions (if config.include_transactions)
2. Write data with `spreadsheets.values.batchUpdate` — plain values first
3. Apply formatting with `spreadsheets.batchUpdate` — freeze row 1, bold headers, currency format for amount columns
4. `PATCH https://www.googleapis.com/drive/v3/files/{id}?addParents={folderId}` — move to configured folder (if set)
5. Return the spreadsheet URL: `https://docs.google.com/spreadsheets/d/{id}`

File naming: `{config.name} — {period_label} — Generated {YYYY-MM-DD}`
Example: `Elyse Coaching — Schedule C — Q1 2026 — Generated 2026-04-03`

Re-runs of the same config + date range create a new file (timestamp in filename). They do not overwrite.

---

## Step 5: Reporting route

Create `src/routes/reports.ts`:

```
GET  /api/reports/configs              — list configs
POST /api/reports/configs              — create config
PUT  /api/reports/configs/:id          — update config
GET  /api/reports/configs/:id/runs     — run history for config
POST /api/reports/configs/:id/generate — generate report (returns drive_link on success)
GET  /api/reports/runs/:id             — get run status
```

Generation runs synchronously (fast enough for current data volumes).

---

## Step 6: ReportsView UI

Create `src/web/components/drilldowns/ReportsView.tsx`. Adapt the layout from `apps/cfo/src/web/components/drilldowns/ReportsView.tsx` — the IRS-line table structure is the right shape.

**Left panel:** Config list. Each item shows name, entity tags, last run date. "New config" opens a drawer. Selecting a config loads the run panel.

**Run panel:**
- Date range selector: presets (Last Month, Last Quarter, Last Year, YTD, Custom)
- Unreviewed warning banner when applicable: "X transactions in this period haven't been reviewed. [Review now →] — or proceed anyway."
- Generate button → shows loading → shows Drive link on success
- Inline preview: summary stats (total income, expenses, net) + IRS-line table

**Run history:** Collapsible list of past runs with date range, Drive link, transaction count, status.

---

## Step 7: MCP tools

Add to `src/mcp-tools.ts`:

```typescript
{
  name: "report_list_configs",
  description: "List available report configurations (Schedule C, Schedule E, family summary, etc.) with their IDs and last run dates.",
  inputSchema: { type: "object", properties: {} }
}

{
  name: "report_generate",
  description: "Generate a financial report for a config and date range. Returns a Google Drive link to the spreadsheet. Use for Schedule C, Schedule E, or spending summaries. Call report_list_configs first to get config IDs.",
  inputSchema: {
    type: "object",
    required: ["config_id", "period"],
    properties: {
      config_id: { type: "string" },
      period: { type: "string", enum: ["last_month", "last_quarter", "last_year", "ytd", "custom"] },
      date_from: { type: "string", description: "Required if period=custom" },
      date_to:   { type: "string", description: "Required if period=custom" }
    }
  }
}
```

Adding 2 tools brings the total to 12. Update `src/web-chat-tools.ts` to keep the in-app chat allowlist at exactly 10 by removing `accounts_list` and `sync_run` (less conversational, still accessible via direct MCP):

```typescript
export const TOOL_ALLOWLIST = [
  'review_status', 'review_next', 'review_resolve', 'review_bulk_accept',
  'transactions_summary', 'transactions_list',
  'rules_list', 'rules_create',
  'report_generate', 'report_list_configs',
];
```

---

## Acceptance Criteria

1. `POST /api/reports/configs/rc_schedule_c_elyse/generate` with `period=last_quarter` returns a Drive URL
2. The spreadsheet has correct IRS line structure: Part I income lines, Part II expense lines, net profit
3. Transactions sheet lists all transactions feeding each line
4. Unreviewed warning shows when unreviewed transactions exist in the date range
5. Re-running creates a new file, not an overwrite
6. `report_generate` MCP tool works from a Claude conversation
7. All four seed configs generate without errors

**Validation milestone:** Run last year's Schedule C for Elyse Coaching on the new system. Compare totals against the CFO agent's `schedule_c_report` output for the same period. They should match within rounding. If they don't, the category mapping or entity filter has a bug — fix before proceeding.
