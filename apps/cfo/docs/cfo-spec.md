# CFO - Financial Management System — Product Specification
**Version:** 0.6 (Complete — All 6 Modules + Migration & Integration)
**Status:** Ready for Claude Code build

---

## Overview & Philosophy

### What This Is
A SaaS-style web application that manages the complete financial picture of a family — including personal spending, real estate operations, and business entities — with an AI agent layer built on top of a well-structured database.

### Architecture Principle
This is **a product first, an agent second.** The primary system is a clean, modular database-backed web application with six distinct modules. An MCP-based AI agent interfaces *with* this system but does not *replace* it. This separation creates more durable, auditable, and maintainable outcomes than an agent-only approach.

### Infrastructure
- **Runtime:** Cloudflare Workers
- **Database:** Neon (serverless Postgres) via Cloudflare Hyperdrive
- **File storage:** R2 (for check images, attachments)
- **Email integration:** Gmail API (server-side parsing)
- **File output:** Google Drive (via existing MCP connection)
- **Users:** Two (Jeremy + Elyse), shared permissions, no role differentiation

**Database rationale:** Neon (free tier, ~75 MB projected usage vs. 500 MB limit) chosen over D1/SQLite for the complex query requirements of the Scenarios module — recursive CTEs for plan inheritance, window functions for scenario comparison, JSONB for account config storage, and efficient bulk writes from the projection engine. Cloudflare Hyperdrive provides connection pooling at the edge, keeping latency close to D1. Workers runtime remains fully on Cloudflare.

**Data hygiene rule:** Raw transaction payloads in the staging table are purged (nulled) after a transaction is reviewed and approved. This is the primary mechanism for staying within the Neon free tier storage limit over time.

### Four Modules (Shared Database)
| # | Module | Purpose |
|---|--------|---------|
| 1 | **Gather** | Collect transactions from all sources |
| 2 | **Review** | Triage, auto-categorize, and human-approve transactions |
| 3 | **Planning** | Create and manage forward-looking financial plans |
| 4 | **Spending** | Compare actuals against plans; visualize cash flow progress |
| 5 | **Net Worth & Scenarios** | Balance sheet, account projections, tax modeling, long-range scenario analysis |
| 6 | **Reporting** | Generate, save, and export financial reports for tax, audit, or reference purposes |

All four modules share a single database. Data flows in one direction: Gather → Review → Budget/Spending/Planning.

### Entities
The system tracks transactions across multiple financial entities. Each transaction must be assigned to exactly one entity. **Entities are fully user-configurable** — users can add, rename, and remove entities from settings at any time. Initial entities at setup:
- Personal / Family
- Whitford House (rental property / business)
- Elyse Coaching (business)
- *(Additional entities added by user as needed)*

### Category Library
The system ships with two pre-built category sets that the user can extend but not delete:

**Tax Categories** — mapped to IRS Schedule C and Schedule E line numbers. Used for business entities. Examples: Advertising, Contract Labor, Insurance, Meals (50%), Office Expense, Rent/Lease, Repairs/Maintenance, Travel, Utilities, Rental Income, Mortgage Interest, Depreciation.

**Budget Categories** — a default set of personal spending categories. Examples: Groceries, Dining, Transportation, Housing, Healthcare, Kids, Travel, Entertainment, Subscriptions, Clothing, Giving.

Users can add new categories to either set, edit names and descriptions, and create entirely new categories outside the pre-built sets. Categories cannot be deleted once transactions have been assigned to them (they can be marked inactive).
Each transaction receives **one category**, which is either:
- A **business/tax category** (if assigned to a business entity), or
- A **personal budget category** (if assigned to the personal entity)

There is no dual-category system. Budget groupings and reporting are derived from this single category field. This keeps the data model simple and the review process fast.

---

## Module 1: Gather

### Purpose
Collect raw transaction data from all sources into a unified staging area. Make the health of every data connection visible and configurable from a single place.

---

### 1.1 Data Sources

#### Teller (Primary / Core)
- API-based bank and credit card transaction sync
- Existing integration — keep as foundation
- Supports the majority of accounts

#### Email Parsing (Gmail API — Server-Side)
Pull structured transaction data from email confirmations via the Gmail API. A Cloudflare Worker polls for new matching emails on a configurable schedule, parses them against defined schemas, and pushes normalized records to the staging table. Sources include:
- **Amazon** — order/shipment confirmations
- **Venmo** — payment notifications
- **Etsy** — sale/purchase receipts
- Additional sources configurable over time

**Architecture note — email is Gather only.** Email enrichment adds supplemental context (order details, merchant info, memo, items) to staged transactions. It never triggers review completion or sets classification state. The Review module (Module 2) owns all approval decisions. This is a deliberate departure from the CFO agent's current behavior, where email parsing and classification were coupled.

**Email parser development process.** Each email source requires a step-by-step validation before shipping:
1. Pull a sample of real emails from each source (Amazon, Venmo, Etsy, Apple) using the Gmail API
2. Inspect the raw payload — headers, subject patterns, HTML/text body structure
3. Confirm which fields are extractable: amount, date, merchant, memo/description, item names, order ID
4. Write the parser and verify it against the sample set
5. Document the search query and sender filters used to find each email type
6. Confirm the parser handles format variations (e.g. Amazon order vs. Amazon shipment vs. Amazon return)

The existing CFO email parsers (`amazon-email.ts`, `venmo-email.ts`, `apple-email.ts`, `etsy-email.ts`) are reference implementations worth reading — they encode real vendor quirks — but they will be rewritten against the new architecture rather than copied. Email dedup tables from the old system are not migrated; emails are re-parsed from scratch.

Each email source has a defined parsing schema (subject patterns, sender addresses, extraction fields). New sources can be added via configuration without code changes where possible.

#### Chrome Extension (Browser-Based)
For sources that cannot be reached via API or email. Designed to operate as autonomously as possible while accommodating required human interactions (login, MFA codes, etc.).

**Initial targets:**
- **Apple Transactions** — accessed via the "Report a Problem" page after login; requires scrolling to load full transaction history
- **Wells Fargo Check Images** — pull check image data not available through Teller

**Distribution:** Internal use only — loaded unpacked in Chrome developer mode. No Web Store publication required.

The extension should:
- Guide the user through login flows with minimal friction
- Handle MFA/2FA gracefully (prompt user when needed, resume automatically after)
- Scroll/paginate to capture complete transaction history
- Push captured data to the Gather module's ingest endpoint

---

### 1.2 Accounts & Sources Configuration Page

A single settings page that provides a unified view of all data connections.

**For each account/source, display:**
- Source type (Teller, Email, Chrome Extension)
- Account name / identifier
- Connection status (Connected, Disconnected, Error, Needs Attention)
- Last successful sync timestamp
- Transactions pulled in last sync
- Total transactions pulled (lifetime or rolling window)
- Next scheduled sync time
- Enable / Disable toggle

**Teller accounts:**
- List all linked bank/credit accounts
- Re-auth flow inline if token has expired

**Email sources:**
- Show which email patterns are active (Amazon, Venmo, Etsy, etc.)
- Instructions visible on-page for how each email source works ("We look for emails from orders@amazon.com with subject starting with 'Your order'...")
- Toggle each source on/off independently
- Ability to test a source (run a one-time parse against recent emails)

**Chrome Extension sources:**
- Show extension install status
- Display each configured site (Apple, Wells Fargo)
- Last run timestamp and result
- Manual "Run Now" trigger per source

---

### 1.3 Sync Scheduling

Configurable per source:
- Frequency options: real-time (webhook), hourly, daily, weekly, manual only
- Display next scheduled run time
- Manual "Sync Now" button per source and global "Sync All"
- Cron expressions visible (advanced mode) for power users

---

### 1.4 Health Dashboard

A quick-glance panel at the top of the Gather page:

- Overall system status (All Good / Attention Needed / Error)
- Count of sources with issues
- Any sources that haven't synced within their expected window flagged in red/yellow
- Recent sync log (last N sync events across all sources, with status and transaction counts)

---

### 1.5 Ingest Staging

All raw transactions from all sources land in a **staging table** before moving to Review. The staging record captures:
- Source (Teller, Email-Amazon, Email-Venmo, Chrome-Apple, etc.)
- Raw payload (preserved)
- Normalized fields: date, amount, description, merchant, account
- Any supplemental data available (email body excerpt, check image URL, geographic data)
- Ingest timestamp
- Status: `staged` → `ready_for_review` / `waiting_for_supplement`

---

## Module 2: Review

### Purpose
Transform raw staged transactions into approved, categorized records ready for reporting. Minimize human effort while maximizing accuracy. Get smarter over time.

The Review module has four sequential stages:
1. **Intake Assessment** — Is this transaction complete enough to review?
2. **Auto-Review** — Apply rules and AI to make a best-guess categorization
3. **Human Review** — Fast, low-friction human approval/correction
4. **Post-Review Learning** — Postmortem analysis to improve future accuracy

---

### 2.1 Stage 1: Intake Assessment

When a transaction arrives from staging, the first question is: **do we have all the information we expect to have?**

**Logic:**
- Check if supplemental data is expected but not yet received
  - Example: Venmo transaction exists in Teller but email confirmation hasn't been parsed yet → hold
  - Example: Apple transaction visible but no Chrome Extension data yet → hold
- If complete → advance to Auto-Review
- If waiting → place in **Hold Queue**

**Hold Queue (visible to user):**
- List of transactions waiting for supplemental data
- What they're waiting for (e.g., "Waiting for Venmo email match")
- Age of hold
- Manual override: "Advance anyway" — forces transaction through to Human Review without the supplemental data, with a flag indicating incomplete data
- Automatic resolution: when the expected data arrives, matching held transactions are released and advanced

---

### 2.2 Stage 2: Auto-Review

All context available about a transaction is assembled and used to make a best-guess `entity` + `category` assignment.

#### 2.2.1 Step 1: Rule Matching
Check against the configured rules library (see Section 2.5). If a rule matches:
- Apply entity and category from the rule
- Flag as `rule-matched`
- Move to Human Review queue (pre-approved, minimal confirmation needed)

#### 2.2.2 Step 2: AI Categorization (if no rule matched)
Assemble a prompt for the LLM containing:

**Signals used:**
| Signal | Weight/Notes |
|--------|-------------|
| Source account | Strong entity signal (e.g., Whitford House checking → Whitford House entity) |
| Transaction description/merchant | Primary category signal |
| Geographic location | Secondary entity signal (Vermont → likely Whitford House; California → less likely) |
| Transaction amount | Caution signal — higher amounts → lower confidence, flag for careful review |
| Past similar transactions | Consistency signal — if N past transactions with similar description all have same category, treat as strong signal |
| Category definitions | Each category has a short text description; compare transaction against these |

**Lookup: Past Similar Transactions**
- Search transaction history for keyword/description matches
- If strong match cluster exists with consistent categorization → high-confidence signal
- If matches are mixed/varied → low-confidence, note this
- Include top matches with their categories in the LLM prompt

**Output of AI Categorization:**
- `entity`: best guess
- `category`: best guess
- `confidence`: high / medium / low
- `reasoning_notes`: human-readable explanation of what factors drove the decision
- `alternate_categories`: 1–2 other categories considered
- `flags`: any notable concerns (high amount, ambiguous description, location mismatch, etc.)

All of this is stored on the transaction record and visible during Human Review.

---

### 2.3 Stage 3: Human Review

#### 2.3.1 Review Queue UI
- Default view: transactions ordered by date, grouped by status (rule-matched first, then AI-categorized by confidence tier, then low-confidence/flagged)
- Shows: date, description, amount, source account, proposed entity, proposed category, confidence indicator

**Filter & Search:**
- Free-text search (fast, responsive — filters as you type)
- Filter by date range
- Filter by proposed category
- Filter by entity
- Filter by confidence level
- Filter by source
- Filter by status (rule-matched, AI-proposed, flagged, on-hold)

#### 2.3.2 Bulk Actions
- Checkbox to select all visible (filtered) transactions
- Set entity for all selected
- Set category for all selected
- Add a note to all selected
- Approve all selected (one-click confirm)

#### 2.3.3 Individual Transaction Actions
- Edit entity
- Edit category (dropdown of all valid categories for the selected entity)
- Add a note (note is stored and available for Post-Review LLM analysis)
- View AI reasoning notes
- Split transaction (see 2.3.5)
- Mark as Transfer (see 2.3.6)
- Mark as Reimbursable (see 2.3.6)

#### 2.3.4 Approval
- Single "Approve" button per transaction, or bulk approve
- Once approved, transaction moves to the finalized transactions table and appears in Budget/Spending module
- No multi-step confirmation — one action, done

#### 2.3.5 Transaction Splitting
- Ability to split a single transaction into 2+ portions
- Each portion gets its own entity + category assignment
- Amounts must sum to original transaction total
- Use case: one charge that covers multiple entities or categories

#### 2.3.6 Special Classifications
**Transfer:**
- Marks a transaction as a movement of money between accounts (not real spending)
- Excluded from budget/spending reports
- Still stored for audit trail

**Reimbursable:**
- Marks a transaction as an expense that will be reimbursed by a third party (employer, client, etc.)
- Excluded from personal/business spending totals
- Still stored; optionally tracked for reimbursement status

---

### 2.4 Stage 4: Post-Review Learning

Runs as a **scheduled background job** after a batch of human reviews are completed (configurable trigger: time-based, or after N approvals).

#### 2.4.1 Postmortem Analysis
For each transaction where the human changed the AI's suggested entity or category:
- Compare: original AI guess vs. human decision
- Review the AI's reasoning notes
- Review any human notes added during review
- Identify the delta and attempt to explain it

Look for patterns:
- Multiple transactions changed the same way → strong rule candidate
- Single transaction changed → possible rule candidate or edge case

#### 2.4.2 Rule Proposals
For each pattern identified, propose a new rule:
- Draft the rule carefully, using the generalizable portion of the transaction description (not unique IDs)
- Identify the expected entity + category
- Flag recurring transactions (same merchant, regular amounts) as especially good rule candidates
- Output: list of proposed rules with rationale

#### 2.4.3 Knowledge File Updates
Maintain a **system knowledge file** — a living document fed into every AI categorization prompt. Contains:
- Learned patterns and heuristics
- Entity/source correlations
- Known edge cases and exceptions
- Category disambiguation notes

After each postmortem:
- Propose new additions based on what was learned
- Review the entire existing file for size/quality
  - Summarize redundant entries
  - Remove outdated or overridden entries
  - Rewrite for clarity and concision
- Ensure the file stays within a reasonable token budget for prompt injection

#### 2.4.4 Learning Review UI
A dedicated page showing the output of the latest postmortem job:

**Sections:**
1. **Proposed New Rules** — list of rule candidates with rationale; user can uncheck any they don't want added
2. **Knowledge File Changes** — diff view of what changed in the knowledge file; user can review, add notes, or reject changes
3. **Add Notes to LLM** — free text field for the user to add any corrections or guidance ("Don't treat X as Y," "When amount > $500, always flag for review")
4. **Submit** — processes accepted rules (adds to rules library), applies user notes (LLM rewrites knowledge file incorporating them), and saves everything

---

### 2.5 Rules Library

A configurable library of categorization rules, editable by the user and populated over time by the Post-Review Learning process.

**Rule structure:**
- Name / description
- Match criteria: one or more of — description contains, description starts with, source account, merchant name, amount range, geographic tag
- Assignment: entity + category
- Created by: user | auto-proposed by system
- Status: active / inactive
- Last matched: timestamp + count

**UI:**
- List view with search/filter
- Ability to create rules manually
- Edit and delete
- Toggle active/inactive
- Preview: "If this rule were applied to past transactions, how many would it have matched?"

---

## Module 3: Planning

### Purpose
Allow the user to create forward-looking financial plans — sets of spending targets and income expectations across all categories — and compare actuals against them. Plans can be short-term (a single month) or span decades. Multiple plans can coexist in the system; one is always designated as the **active comparison plan** used by the Spending module.

---

### 3.1 Core Concepts

#### Plan
A plan is a complete or partial financial model consisting of:
- **Category amounts** — a spending target or income expectation for each category, expressed as monthly or annual figures
- **Time-based adjustments** — amounts can change over time via a fixed rate or scheduled dollar-amount deltas
- **One-time items** — anticipated one-time expenses or income at a specific date
- **A start date** and optional **end date**

Plans cover **both income and expenses**, and span **all entities**. Income is **broken out by source** (salary/W-2, rental income, business revenue, investment income, Social Security, other) but collapsible to a single total line in all views. Entity-level filtering is a reporting/spending concern, not a planning concern — but all category data is available for entity-specific views when needed.

Plans support **20–40 year horizons** in v1. Forecasting view adapts automatically (monthly for ≤24 months, annual beyond).

#### Plan Types: Foundation vs. Modification
| Type | Description |
|------|-------------|
| **Foundation Plan** | A standalone plan defining complete category amounts from scratch. Every plan chain must have exactly one foundation. |
| **Modification Plan** | Extends another plan (foundation or another modification) by specifying only what changes. All unspecified categories inherit from the parent. |

Modifications can be chained: Foundation → Mod A → Mod B → Mod C. To resolve a modification plan's actual values, the system starts at the foundation and applies each modification in order.

**Modification values are expressed as:**
- **Delta** — a `+` or `-` dollar amount applied to the inherited value (e.g., `-$500/mo starting 2030`)
- **Fixed Override** — a hard number that replaces the inherited value regardless of what the parent says

This means changing a foundation plan automatically propagates through all descendant modifications, except where a fixed override is in place.

---

### 3.2 Category Amounts & Time-Based Changes

Each category in a plan has:

#### Base Amount
- Monthly **or** annual — user toggles per-category
- Can be `$0` (category exists but no planned spend)
- Inherited from parent plan if this is a modification and no override is set

#### Time-Based Adjustments (two mechanisms)
**1. Fixed Rate (inflation / growth)**
- Apply a percentage rate per year (e.g., +3% annually)
- Start date for when the rate begins applying
- Compounding from base amount

**2. Scheduled Dollar-Amount Changes**
- A list of dated changes: `{date, delta_amount}` per entry
- Each change is a `+` or `-` from the amount in effect at that time
- Changes stack cumulatively — after the date of each change, the new running total applies going forward
- Example: base $1,200/mo → `2030-01-01: -$500` → `$700/mo from 2030 onward`
- Example with multiple: base $200/mo → `2028: +$100` → `2033: -$150` → results in $300, then $150

Both mechanisms can coexist on a category: a base rate inflation applies continuously, and discrete scheduled changes layer on top.

---

### 3.3 One-Time Items

Separate from recurring category amounts, a plan can include anticipated one-time financial events:

**Fields:**
- Name / description
- Type: Expense or Income
- Date (specific date or month/year)
- Amount
- Category (optional — links to a category for reporting purposes)
- Notes

**Behavior:**
- One-time items do not affect monthly/annual category budgets
- They are factored into cash flow projections and account balance forecasting
- Visible in planning timelines and forecasts as discrete events
- Example: kitchen remodel ($20,000 on 2025-05-15), solar installation ($35,000 on 2026-Q3), college tuition payment

---

### 3.4 Active Plan

At any time, exactly one plan is designated the **active plan**. This is the plan the Spending module compares actuals against. The active plan can be changed at any time via a toggle in the Spending module (or the plan list).

The system always knows which plan is active and surfaces this prominently so there's no confusion about what you're measuring against.

---

### 3.5 Plan List View

The main Planning page shows all plans in the system:

**Per plan, display:**
- Plan name
- Type (Foundation / Modification)
- Parent plan (if modification)
- Start date / end date
- Status: Active Comparison Plan | Draft | Archived
- Last modified
- Quick actions: Edit, Duplicate, Extend (create child modification), Set as Active, Archive

**Indicators:**
- Which plan is currently active (used in Spending module)
- Visual chain view: show foundation → modification hierarchy as a tree

---

### 3.6 Plan Editor

The editor is the primary interface for configuring a plan's amounts.

#### 3.6.1 Category Grid
All categories listed in rows. Columns:

| Column | Description |
|--------|-------------|
| Category name | With entity type indicator |
| Type toggle | Monthly / Annual (per-category) |
| Base amount | Editable inline |
| Inherited from | (Modification plans only) Shows parent value being overridden |
| Override type | Delta / Fixed / Inherited (Modification plans only) |
| Adjustments | Indicator if time-based changes are configured; click to expand |
| Suggested amount | AI-surfaced estimate based on past spending (see 3.6.2) |
| Actions | Edit adjustments, view transactions, clear override |

#### 3.6.2 Suggested Amounts
For each category, the system can suggest a budget amount based on historical actuals:

- User selects lookback window: last 1 month / 3 months / 6 months / 1 year / 2 years
- System calculates average monthly (or annual) spend for that category over the window
- Displayed alongside the editable amount field
- One-click "Use this" to apply the suggestion
- User can then drill into the transactions that composed that average — and quickly exclude any outliers or one-time items that shouldn't inform the baseline

#### 3.6.3 Time-Based Adjustment Editor
Accessed per-category via an expand/edit action:

- Toggle between "Fixed Rate" and "Scheduled Changes" (or both)
- For Fixed Rate: enter percentage, start date
- For Scheduled Changes: date-ordered list of `{date, delta}` entries; add/remove rows
- Preview panel: shows the resulting monthly amount year-by-year from now through a configurable horizon

#### 3.6.4 One-Time Items Section
Below the category grid:
- List of all one-time items for this plan
- Add / edit / delete
- Fields as described in 3.3
- Sorted by date

#### 3.6.5 Plan Metadata
- Plan name
- Plan type (Foundation or Modification; if Modification, select parent)
- Start date / end date
- Notes / description
- Active status

---

### 3.7 Plan Inheritance View (Modification Plans)

When editing a modification plan, the category grid shows three values side-by-side for each category:
- **Parent value** — what the parent plan specifies (resolved, not raw)
- **This plan's override** — the delta or fixed value defined here (blank if inherited)
- **Effective value** — the resolved amount after applying this plan's override to the parent

This makes it immediately clear what has changed and what is being inherited.

---

### 3.8 Forecasting View

A forward-looking projection built from the active (or any selected) plan:

- Timeline: month-by-month or year-by-year, configurable horizon (1 year, 5 years, 10 years, through retirement)
- Shows: planned income, planned expenses, net (surplus/deficit) per period
- One-time items appear as discrete spikes on the timeline
- Time-based adjustments are reflected as the amounts change over time
- Toggle to overlay actuals (where available) against plan
- Toggle to show entity-level breakdown within the forecast

This view is primarily read-only — edits happen in the plan editor.

---

### 3.9 Data Model Additions

| Table | Key Fields |
|-------|------------|
| `plans` | id, name, type (foundation/modification), parent_plan_id, start_date, end_date, is_active, notes, created_at |
| `plan_category_amounts` | id, plan_id, category_id, amount, period_type (monthly/annual), override_type (delta/fixed/inherited), base_rate_pct, base_rate_start_date |
| `plan_category_changes` | id, plan_category_amount_id, effective_date, delta_amount |
| `plan_one_time_items` | id, plan_id, name, type (expense/income), date, amount, category_id, notes |

---

### 3.10 Decisions

1. **Long-range forecasting horizon** — 20–40 year horizons supported in v1. This is core to the system's purpose; retirement planning from age 49 through end-of-life requires full horizon support.

2. **Income modeling granularity** — Broken out by source (salary/W-2, rental income, business revenue, investment income, Social Security, other). Each source is individually configurable in plans and collapsible to a total in all views. Granularity is intentional — robust income modeling is a first-class requirement.

3. **Archived plans in comparison targets** — Active and draft plans only. Archived plans are excluded from all selection lists (Spending module active plan toggle, Scenario plan selection, etc.).

4. **Plan duplication vs. extending** — Two distinct operations with different behaviors:
   - **Duplicate** (copy an existing plan): creates a sibling with the same parent as the original. The duplicate is a full independent copy — not linked to the original.
   - **Extend** (build on a plan): creates a child Modification plan with the selected plan as parent. Changes in the parent flow through to the child unless overridden.
   Both operations are available from the plan list with distinct labels.

5. **New category auto-add to plans** — Confirmed. When a new category is created, it is automatically added to all existing plans with a `$0` base amount. User can then set a budget amount if applicable.
## Module 4: Spending

### Purpose
Show how actual spending (reviewed transactions only) compares to one or more plans across a selected time period. The primary interface for answering "are we on track?" — with clear visualization of past actuals, present position, and projected trajectory through the end of the period.

---

### 4.1 Core Principles

- **Reviewed transactions only.** Unreviewed transactions are excluded from all calculations. The system prominently alerts the user when unreviewed transactions exist within the selected date range, with a direct link to review them.
- **Plan-relative.** Every number displayed is contextualized against at least one plan.
- **Past vs. future is always visually distinct.** Actuals (past) and projections (future) use different visual treatment — never ambiguous.
- **Income and expenses both included.** The module handles both sides of the ledger; account balances and capital appreciation are out of scope here (separate module).

---

### 4.2 Report Configuration

Controls displayed at the top of the page. Changes update the entire view.

#### Spending View Presets
Named views are saveable and recallable from a dropdown (e.g., "Monthly Household Check-In," "Whitford House Annual Review"). A view saves the full configuration: plan selection, date range preset, category/group selection, entity filter, and period type.

#### Entity Filter
An entity filter is available in addition to category groups. The two work independently and can be combined. Entity filter narrows the transaction set; category groups control how the filtered transactions are aggregated and displayed.

#### Income Tab
Income is displayed in a **separate tab** within the Spending module, not mixed into the expense chart. The income tab follows the same structure (chart + table, plan vs. actual, broken out by income source) but is visually and navigationally distinct from the expense view.
- Select one or more plans to compare against
- One plan is always the **primary plan** (used for delta calculations when only one is selected)
- When multiple plans are selected: actuals are shown alongside all plan lines, but no delta column is shown (see 4.5.3)
- Indicator showing which plan is the current active plan

#### Date Range
- Start date and end date (end date can be in the future)
- Presets: This Month, This Quarter, This Year, Last 12 Months, Custom
- When the end date is in the future, the portion beyond today is the projection zone

#### Reporting Period
- Toggle: **Monthly** or **Annual**
- Smart default: if date range spans more than 24 months, default to Annual; otherwise Monthly
- User can override at any time

#### Category Selection
- Multi-select from all categories (income and expense)
- Support for **aggregated category groups** (see 4.3)
- "All categories" default
- Selected set is saved per user session; named views can be saved (see 4.3)

#### Unreviewed Transactions Alert
- If unreviewed transactions exist within the selected date range:
  - Banner: "You have $X in unreviewed transactions in this period. [Review now →]"
  - Not blocking — the report still loads, but the alert is prominent

---

### 4.3 Aggregated Category Groups

Categories can be combined into named groups that behave like a single category throughout the Spending module.

**Examples:** "Home Operating" might combine utilities + maintenance + insurance. "Kids" might combine tuition + activities + clothing.

**Behavior:**
- An aggregated group sums actuals and plan amounts across its member categories
- Displayed as a single row in tables and a single line in charts
- Toggle to expand/collapse into constituent categories

**Management:**
- Groups are saved and reusable across sessions
- Create/edit/delete from a configuration panel within the Spending module (or a global settings page)
- A group can be used as a selection unit in the category picker

---

### 4.4 Chart View

A line chart occupying the upper portion of the dashboard.

#### Lines Displayed
| Line | Style | Description |
|------|-------|-------------|
| Actual spending | Solid line | Cumulative or per-period actual spend from reviewed transactions |
| Plan (primary) | Dotted line, same color family as actual | Plan amounts pro-rated to match the reporting period |
| Plan (additional) | Dotted lines, distinct colors | Additional selected plans |
| Combined total | Heavier weight line | Aggregate across all selected categories (toggleable) |

Each selected category or aggregated group gets its own color pair (solid actual + dotted plan). The combined total uses a neutral/bold color.

#### Temporal Zones
- **Past zone** (start date → today): normal background color
- **Future zone** (today → end date): visually distinct — lighter background shading or a subtle hatched fill
- A clear vertical marker at "today"

#### Interactions
- **Toggle lines on/off** — each category/group has a visibility toggle in a legend panel; toggling visibility does not remove the category from the analysis or table
- **Hover tooltip** — shows values for all lines at the hovered date
- **Click a point** — drills into the transactions that make up that period's actuals for that category

---

### 4.5 Table View

Below the chart, a tabular breakdown of the same data.

#### 4.5.1 Structure

Rows: one per selected category or aggregated group (expandable for groups), plus a **Total** row at the bottom.

Columns: one per reporting period (month or year) within the date range, plus a **Total** column at the far right summing the full period.

#### 4.5.2 Cell Contents (Single Plan)
Each cell shows:
- **Actual** — spend for that category in that period
- **Plan** — what the plan anticipated for that period (pro-rated if partial period)
- **Δ (Delta)** — actual minus plan; color-coded (over budget = red, under = green; reversed for income categories)

Periods in the future show plan amount only, with actual blank or replaced by the projected figure (see 4.5.4).

#### 4.5.3 Multi-Plan Mode
When multiple plans are selected:
- Each period cell shows: **Actual** + one column per plan
- No delta columns — the user reads the comparison visually
- Plans are labeled by name in column sub-headers

#### 4.5.4 Projection Column
For future periods, the system calculates a **projected actual** based on the average spending rate over the actuals portion of the date range:

- `Projected = (total actuals to date / days elapsed) × days remaining`
- Displayed in a distinct style (italics or lighter color) to distinguish from real actuals
- One-time items from the plan that fall in future periods are included in the plan line for those periods

#### 4.5.5 Pro-Ration Rules
- Monthly plan amounts: divide by days in month, multiply by days in period (for partial months)
- Annual plan amounts: divide by 365, multiply by days in period; annotate the column header to indicate this is an annualized figure being shown monthly
- Partial first/last periods are always pro-rated automatically

---

### 4.6 One-Time Items in the Spending View

Planned one-time items (from the Planning module) are surfaced in the Spending module:

- Appear as markers on the chart at their scheduled date (vertical tick on the plan line)
- Appear in the table in the period they fall in, as a distinct sub-row under the relevant category (or in a dedicated "One-Time Items" section)
- Future one-time items are included in the projected plan total
- Past one-time items that have corresponding transactions are matched automatically; unmatched ones are flagged

---

### 4.7 Summary Cards

Above the chart, a row of summary cards giving at-a-glance status for the selected configuration:

| Card | Description |
|------|-------------|
| **Total Spent** | Sum of actuals across all selected categories, period to date |
| **Total Planned (to date)** | What the plan anticipated through today |
| **Δ vs. Plan** | Over / under, absolute and percentage |
| **Projected End Total** | Where actuals are trending by end date |
| **Plan End Total** | What the plan calls for by end date |
| **Projected Δ** | Projected vs. plan at end of period |

When multiple plans are selected, the delta cards are hidden and replaced with a "Multiple plans selected — see chart" note.

---

### 4.8 Data Model Additions

| Table | Key Fields |
|-------|------------|
| `category_groups` | id, name, created_by, created_at |
| `category_group_members` | id, group_id, category_id |
| `spending_views` | id, name, plan_ids (JSON), date_range_preset, start_date, end_date, category_ids (JSON), group_ids (JSON), period_type, created_at |

---

### 4.9 Open Questions

1. **Saving report configurations** — Should named spending views be saveable and appear in a dropdown for quick recall? (e.g., "Monthly Household Check-In," "Whitford House Annual Review")
2. **Income display** — Should income categories be shown on the same chart as expenses (flipped axis or separate series), or should income have its own section/tab?
3. **Entity filtering** — The planning module is entity-agnostic, but users may want an entity filter in spending (e.g., "show only Whitford House categories"). Should this be a filter option here, or is aggregated category groups sufficient for that purpose?
4. **Export** — Should the table be exportable to CSV or a spreadsheet for external use?
5. **Mobile view** — The chart + table layout is desktop-oriented. Is a simplified mobile view needed, or is desktop-first acceptable for this tool?

---

## Module 5: Net Worth & Scenarios

### Purpose
Provide a comprehensive long-range view of financial health — not just cash flow, but balance sheet: how assets grow, liabilities shrink, taxes accumulate, and net worth evolves over time. Enable scenario analysis that runs a full projection from today through a chosen horizon, optimizes account draw-down and surplus allocation decisions, surfaces red flags, and produces a saveable, comparable report.

This is the most computationally complex module. Generation of a scenario may take meaningful time; it runs as a background job and the result is saved as a snapshot.

---

### 5.1 Core Concepts

#### Balance Sheet vs. Cash Flow
Modules 3 and 4 deal with **cash flow** — income and expenses moving through the system. Module 5 deals with the **balance sheet** — the value of assets and liabilities at any point in time, and how that changes.

The two connect: cash flow surpluses and deficits from Module 4's plans are inputs that drive balance sheet changes in Module 5. But Module 5 also captures things that never appear in cash flow: appreciation of a home, compounding of investment returns, growth of a retirement account.

#### Scenarios
A scenario is the Module 5 equivalent of a plan. It defines:
- A time horizon (start date → end date)
- One cash flow plan (from Module 3)
- A set of accounts with current balances and configured rates
- Tax assumptions
- Allocation rules for surpluses and deficits

A scenario is **run** (computed) and then **saved as a snapshot**. The snapshot is immutable — a point-in-time record of the projection as of when it was run. Scenarios can be rerun at any time to produce a new snapshot, enabling before/after comparison.

---

### 5.2 User Profile

Required demographic and household data that governs tax rules and retirement account access:

| Field | Purpose |
|-------|---------|
| Date of birth (per person) | Age-based retirement account rules (59½, 72 RMD, etc.) |
| Filing status | Single / Married Filing Jointly / etc. |
| State of residence | State income tax; changes over time (e.g., CA → VT relocation) |
| Expected retirement date | Signals shift in income model |

State of residence supports a timeline: "CA through mid-2027, then VT" — tax calculations use the correct state rules for each projection year.

---

### 5.3 Account Configuration

Accounts here represent **balance sheet items** — assets and liabilities — not transaction accounts (which are in the Gather module). They may overlap with Teller accounts but are configured independently for projection purposes.

#### 5.3.1 Account Types

| Type | Asset / Liability | Notes |
|------|------------------|-------|
| Checking / Savings | Asset | Liquid; interest rate applies |
| Taxable Brokerage | Asset | Investment account; capital gains tax on withdrawal |
| Traditional 401(k) / IRA | Asset | Pre-tax; ordinary income tax + possible penalty on withdrawal |
| Roth 401(k) / Roth IRA | Asset | Post-tax; qualified withdrawals tax-free |
| Real estate (primary) | Asset | Appreciates; capital gains exclusion rules apply on sale |
| Real estate (investment) | Asset | Appreciates; depreciation recapture + capital gains on sale |
| 529 Education Savings | Asset | Contribution schedule; qualified withdrawal modeling; penalty on non-qualified withdrawals |
| Social Security | Income source | Configured per person: expected monthly benefit, start age (62–70), survivor benefit rules |
| Private equity / stock options | Asset | Complex basis; vesting schedule; configurable |
| Cash value life insurance | Asset | If applicable |
| Mortgage | Liability | Amortizing; monthly payment reduces principal |
| HELOC / Line of credit | Liability | Variable balance; interest rate applies |
| Other loan | Liability | Fixed or variable; amortizing or interest-only |
| Other asset | Asset | Generic; user-defined appreciation rate |

#### 5.3.2 Account Fields (All Types)

| Field | Description |
|-------|-------------|
| Name | Display name |
| Type | From list above |
| Asset or Liability | Determined by type; shown explicitly |
| Entity | Which family entity this account belongs to |
| Current balance / value | Starting point for projection |
| Balance history | Log of past recorded balances with dates (see 5.3.5) |

#### 5.3.3 Rate of Return / Interest Rate

Each account has a **rate schedule** — identical in structure to the time-based adjustment system in Module 3:

- A **base rate** (annual percentage)
- **Scheduled rate changes**: list of `{effective_date, new_rate}` entries — the rate changes to the new value on that date and applies going forward
- Examples:
  - Investment account: 7% today → 3% from 2045 (shift to conservative portfolio)
  - ARM mortgage: 5.67% today → +0.5% per year starting 2027 (rate adjustment schedule)
  - Savings account: 4.8% today → assume declining to 3.5% in 2026

#### 5.3.4 Type-Specific Configuration

**Real Estate:**
- Purchase price (cost basis)
- Purchase date
- Estimated current market value
- Appreciation rate schedule (as above)
- If primary residence: track eligibility for §121 exclusion ($250K/$500K)
- "What would I net if I sold on date X?" calculator: applies appreciation to that date, subtracts cost basis, calculates estimated capital gain, applies exclusion if eligible, estimates tax, outputs net proceeds

**Investment / Brokerage:**
- Cost basis (can be entered as multiple tax lots: `{date, amount, basis_per_share_or_pct}`)
- Short-term vs. long-term gain breakdown based on holding periods
- Automatic application of LTCG vs. STCG rates at withdrawal

**Retirement Accounts (401k, IRA, Roth):**
- Contribution history (optional — for basis tracking in Roth)
- Current balance
- Projected annual contributions (from cash flow plan or entered here)
- Account owner's age governs: early withdrawal penalty (pre-59½), RMD start age (73 under current law)

**Mortgage / Amortizing Debt:**
- Original loan amount
- Origination date
- Term (years)
- Current principal balance
- Interest rate (with schedule)
- Monthly payment (auto-calculated or overridden)
- System generates full amortization schedule; principal balance in the projection decreases accordingly

**529 Education Savings:**
- Account owner and beneficiary
- Current balance
- Annual contribution amount and schedule (contributions come from cash flow plan)
- Projected qualified withdrawals: `{beneficiary, start_year, annual_amount, duration}` (e.g., college 2028–2032)
- Non-qualified withdrawal penalty: 10% + ordinary income tax on earnings portion
- Two accounts: one per child

**Social Security:**
- Configured per person (Jeremy, Elyse)
- Expected monthly benefit at full retirement age (FRA) — user-entered from SSA estimate
- Elected start age (62–70); benefit adjusted per SSA delayed/early claiming rules
- Survivor benefit: if one spouse dies, survivor receives higher of the two benefits
- SS income included in ordinary income calculation for tax purposes (up to 85% taxable above threshold)

**Private Equity (Gong, Ripple, etc.):**
- Current estimated value (user-entered; no live feed)
- Cost basis / strike price
- Vesting schedule (optional)
- Liquidity events: `{date, type (IPO/tender/sale), estimated_price_per_share}` — one-time items that trigger a realization event in the scenario
- Applicable tax treatment (ISO/NSO/RSU — affects ordinary income vs. capital gain treatment)

#### 5.3.5 Balance History Logging

The system maintains a time-series log of recorded account balances:
- User can manually enter a balance at any date (e.g., pulled from a statement)
- Teller-linked accounts can optionally sync current balance automatically
- Historical log is used to display actual balance trajectory in the visualization
- Enables comparison of actual vs. projected appreciation rates over time

---

### 5.4 Tax Configuration

The tax engine needs enough information to estimate annual tax liability for any projection year. It is intentionally an **estimator**, not a tax filing tool.

#### 5.4.1 Federal Income Tax — Full Engine (v1)

The tax engine implements the complete federal tax picture in v1:

- **Ordinary income tax** — bracket schedules by year and filing status; user can add future-year assumptions; bracket schedules can be set to inflate by X% per year
- **Capital gains** — LTCG and STCG rates; NIIT surcharge (3.8%) applied when MAGI exceeds threshold ($250K MFJ under current law)
- **AMT (Alternative Minimum Tax)** — AMT income calculation, exemption phaseout, tentative minimum tax vs. regular tax comparison; particularly relevant for ISO exercise years
- **QBI deduction (Section 199A)** — 20% deduction on qualified business income for pass-through entities (coaching businesses); subject to W-2 wage / property limitations
- **Depreciation recapture** — 25% rate on §1250 gain when investment real estate is sold; calculated from accumulated depreciation on the Whitford House account

- Tax bracket schedules stored by year
- System ships with current brackets; user can add/modify future year assumptions
- Bracket schedules can be set to "inflate by X% per year" as a simplifying assumption (accounts for bracket creep adjustments)
- Filing status determines which bracket table applies

#### 5.4.2 State Income Tax

- State configured per the User Profile timeline
- Flat rate or bracket schedule per state (configurable)
- CA and VT pre-loaded as priority states

#### 5.4.3 Capital Gains

- LTCG and STCG federal rates (with NIIT surcharge threshold for high-income years)
- State capital gains treatment (some states tax at ordinary income rates)
- Depreciation recapture rate for investment real estate (25%)

#### 5.4.4 Retirement Account Withdrawal Rules

- Early withdrawal penalty: 10% if under 59½ (with standard exceptions)
- RMD starting at age 73: calculated as balance / IRS life expectancy factor
- Roth qualified distribution rules: account age ≥ 5 years AND owner age ≥ 59½

#### 5.4.5 Deductions

- Standard deduction (by year / filing status — built in, adjustable)
- Itemized deductions the user can configure:
  - Mortgage interest (auto-calculated from the mortgage account's amortization schedule)
  - Charitable donations (annual amount, changeable over time)
  - State and local taxes (SALT, capped at $10K under current law — adjustable)
  - Other itemized deductions (user-defined line items)
- System selects greater of standard vs. itemized automatically, or user can force one

#### 5.4.6 Tax Estimate Output
For any projection year, the tax engine outputs:
- Estimated federal + state income tax liability
- Estimated capital gains tax (if any realized gains)
- Effective tax rate
- Recommended amount to set aside (factoring in likely withholding from employment income)

---

### 5.5 Scenario Definition

Creating a scenario requires:

| Input | Description |
|-------|-------------|
| Name | For the scenario |
| Start date | Usually today or the start of the current year |
| End date | Any future date; 10–40 year horizons supported |
| Cash flow plan | One plan from Module 3 (income + expenses) |
| Accounts | Which balance sheet accounts to include |
| Initial balances | Confirmed or adjusted from the account's current logged balance |
| Allocation rules | How to handle surplus / deficit cash flow (see 5.6.3) |
| Tax assumptions | Use configured defaults or override for this scenario |

---

### 5.6 Scenario Engine

The engine runs in a background job and produces a year-by-year (or month-by-month for near-term periods) projection. It processes in two passes.

#### 5.6.1 Historical Phase (Start → Today)

- Plot actual recorded account balances from the balance history log
- Calculate actual appreciation rates achieved vs. configured rates
- Show actual cash flow from reviewed transactions vs. the plan
- This is the "anchor" — the projection builds forward from today's actual balances

#### 5.6.2 Forward Projection Phase (Today → End Date)

For each period (month or year):

**Step 1: Cash Flow from Plan**
- Pull income and expense amounts from the selected Module 3 plan for the period
- Apply one-time items that fall in this period
- Apply time-based adjustments (inflation, scheduled changes)
- Calculate net cash flow: `income − expenses − estimated taxes`

**Step 2: Tax Calculation**
- Estimate income tax liability for the year based on:
  - Plan income for the year
  - Any realized capital gains from account transactions in this period
  - Applicable deductions
- Output: tax liability + recommended cash set-aside

**Step 3: Account Growth**
- Apply each asset account's rate of return to its current balance for the period
- Apply amortization to each debt account (reduce principal by scheduled payment)
- Apply any scheduled rate changes that take effect this period

**Step 4: Surplus / Deficit Allocation** *(see 5.6.3)*
- If net cash flow is positive (surplus): allocate to accounts per allocation rules
- If net cash flow is negative (deficit): draw from accounts per allocation rules
- Record any **allocation decisions** that require optimization (see 5.6.4)
- Advance all account balances to end-of-period values

**Step 5: Period Summary**
- Net worth at end of period = sum of all asset balances − sum of all liability balances
- Cash available for period
- Tax liability for year (aggregated)
- Flags (see 5.6.5)

#### 5.6.3 Allocation Rules

Rules governing where surplus cash goes and where deficit cash is drawn from. Configured per scenario.

**Surplus allocation waterfall** (ordered list, user-configurable):
1. Fund emergency reserve up to target balance (e.g., 6 months expenses in savings)
2. Max out HSA contribution
3. Max out Roth IRA / 401(k) up to annual limit
4. Pay down high-interest debt above threshold rate
5. Deposit remainder into taxable brokerage / savings
6. *(User can reorder, add, remove rules)*

Look-ahead rule: before committing a surplus to a long-term account, check whether the projected cash flow for the next N months will require a draw. If so, keep funds liquid instead. Log as a flagged decision.

**Deficit draw waterfall** (ordered list, user-configurable):
1. Draw from checking / savings (liquid accounts first)
2. Draw from taxable brokerage (minimize capital gains)
3. Draw from Roth IRA contributions (basis only, no tax or penalty)
4. Draw from Traditional IRA / 401(k) (incur ordinary income tax; penalty if pre-59½)
5. *(User can reorder)*

Tax impact of each draw is calculated at time of draw and added to the year's tax liability.

#### 5.6.4 Two-Pass Optimization

**Pass 1 — Forward projection:**
Run the full scenario with the default allocation rules. Flag any period where:
- The allocation engine hit a decision point that benefits from look-ahead (e.g., "should this surplus go into a retirement account given expected draws in year 3?")
- The default waterfall produced a suboptimal tax outcome
- A retirement account withdrawal was triggered before age 59½

Collect all flagged decisions into an **optimization queue**.

**Pass 2 — Optimization:**
For each flagged decision, evaluate 2–3 alternative allocation choices and model their downstream impact on net worth at end of period. Select the option with the best long-term net worth outcome (or flag to the user when it's genuinely ambiguous). Rerun affected periods with the optimized decisions. Recalculate net worth trajectory.

**Roth Conversion Proposals (included in Pass 2):**
In years where ordinary income is projected to be low (e.g., early retirement before Social Security begins, sabbatical years), the engine evaluates whether a partial Traditional IRA → Roth conversion would reduce lifetime tax burden. Criteria:
- Current year marginal rate is lower than projected future rate at RMD age
- Conversion amount fills the current bracket without crossing into the next
- Net present value of tax savings exceeds conversion tax cost
Proposed conversions are surfaced as optimization recommendations with supporting rationale, not executed automatically.

#### 5.6.5 Flags and Alerts

The engine surfaces the following automatically:
| Flag | Condition |
|------|-----------|
| **Funding gap** | Cash/liquid accounts projected to go negative in a period |
| **Penalty withdrawal** | A pre-59½ retirement draw is required to cover a deficit |
| **RMD due** | RMD start age reached for any retirement account |
| **Tax spike** | Estimated tax liability in a year exceeds X% more than prior year |
| **Low liquidity** | Liquid account balance falls below 3-month expense buffer |
| **Liability payoff** | A debt account reaches $0 (mortgage paid off, etc.) — positive flag |
| **Optimization note** | A Pass 2 allocation decision differed from Pass 1 — explanation shown |

---

### 5.7 Visualization

#### 5.7.1 Net Worth Chart
- Line chart: net worth over time (total and per-account)
- X-axis: time (monthly for first 2 years, annual beyond)
- Shading: past (actual balance history) vs. future (projected)
- Vertical markers at: today, key life events (retirement, RMDs, planned liquidity events)
- Toggle individual accounts on/off (same as Spending module pattern)
- "Combined net worth" line always available as an overlay

#### 5.7.2 Account Balance Chart
- Same chart structure, but each line represents one account balance over time
- Assets positive, liabilities shown as negative or in a separate panel
- Debt accounts show principal declining to $0

#### 5.7.3 Annual Summary Table

Rows: one per projection year. Columns:

| Column | Description |
|--------|-------------|
| Year | Projection year |
| Net Income (Plan) | Income − expenses per the cash flow plan |
| Tax Liability | Estimated federal + state |
| Net After Tax | Net income minus taxes |
| Account Changes | Total appreciation/growth across all accounts |
| Net Worth (EOY) | Total assets − liabilities at end of year |
| Δ Net Worth | Change from prior year |
| Flags | Any flags triggered this year |

#### 5.7.4 Flags Panel
A dedicated panel listing all flags generated by the scenario, sorted by date. Each flag links to the relevant year in the table.

#### 5.7.5 Optimization Summary
After Pass 2, a panel summarizing:
- How many allocation decisions were changed from Pass 1 default
- Net worth impact of the optimizations (Pass 1 end vs. Pass 2 end)
- Decisions that remain ambiguous with a note explaining the trade-off

---

### 5.8 Scenario Management

#### 5.8.1 Scenario List
Main landing page for the module. Per scenario:
- Name, creation date, last run date
- Date range, plan used
- End-state net worth (from last run)
- Status: Draft / Run Complete / Stale (underlying data has changed since last run)
- Actions: Run, View Results, Edit, Duplicate, Archive

#### 5.8.2 Snapshots
Each time a scenario is run, the result is saved as an immutable snapshot:
- Timestamp of run
- All inputs at time of run (plan version, account balances, tax config)
- Full projection output

A scenario can have multiple snapshots. Viewing a scenario shows the latest snapshot by default; user can select an earlier snapshot to compare.

#### 5.8.4 Scenario Run Model
Scenario generation runs as an **async background job**:
- User hits "Run Scenario" — job is queued immediately
- UI shows job status: Queued → Running → Complete / Failed
- On completion, user is notified (in-app indicator; optionally email)
- Results load automatically when the user returns to the scenario view
- A scenario can be re-run at any time; each run produces a new timestamped snapshot
Select two snapshots (same scenario at different times, or two different scenarios) and view:
- Net worth trajectory side-by-side on the same chart
- Annual summary table with two columns per year (one per snapshot)
- Delta column: difference in net worth at each year end

---

### 5.9 Data Model Additions

| Table | Key Fields |
|-------|------------|
| `balance_sheet_accounts` | id, name, type, asset_or_liability, entity_id, current_balance, notes |
| `account_rate_schedule` | id, account_id, base_rate, effective_date |
| `account_balance_history` | id, account_id, balance, recorded_date, source (manual/teller) |
| `account_cost_basis_lots` | id, account_id, acquisition_date, amount, basis, lot_type |
| `account_amortization` | id, account_id, original_principal, origination_date, term_months, current_principal |
| `user_profile` | id, person_name, dob, filing_status, retirement_date |
| `state_residence_timeline` | id, user_profile_id, state, effective_date |
| `tax_bracket_schedules` | id, year, filing_status, brackets (JSON), standard_deduction |
| `tax_deduction_config` | id, user_profile_id, type, annual_amount, effective_date |
| `scenarios` | id, name, start_date, end_date, plan_id, account_ids (JSON), tax_config_id, allocation_rules (JSON), status |
| `scenario_snapshots` | id, scenario_id, run_at, inputs_snapshot (JSON), results (JSON) |
| `scenario_flags` | id, snapshot_id, period_date, flag_type, description, resolved |
| `allocation_decisions` | id, snapshot_id, period_date, decision_type, pass1_choice, pass2_choice, net_worth_impact, rationale |

---

### 5.10 Open Questions

1. **Tax engine depth** — How precise does tax estimation need to be? AMT, NIIT, QBI deduction, and depreciation recapture add significant complexity. Recommend implementing federal ordinary income + LTCG/STCG + state as v1, with AMT/NIIT/QBI as a v2 layer.
2. **Private equity valuation** — Gong and Ripple values are user-entered estimates. Should there be a mechanism to log valuation updates over time (like balance history for other accounts), so the historical chart shows the evolution of those estimates?
3. **Roth conversion modeling** — A common optimization is converting Traditional IRA → Roth in low-income years. Should the engine propose this as an optimization, or is that out of scope for v1?
4. **College funding (529)** — You have 529 projections for both kids in your existing retirement model. Should 529 accounts be a supported account type here, with contribution schedule and qualified withdrawal modeling?
5. **Social Security** — For a full long-range retirement model, Social Security income is a significant input. Should the scenario engine support entering expected SS benefit amounts starting at a given age?
6. **Scenario run time** — A 30-year two-pass optimization over a complex account set could be slow. Should the UI support async job status (run started → notify when complete) vs. waiting inline?
7. **Sensitivity analysis** — Would it be useful to auto-run a scenario at ±1% return rate variance and show the resulting net worth range as a band around the projection line? (i.e., "if returns are 6–8% instead of 7%, here's the range")

---

---

## Module 6: Reporting

### Purpose
Generate clean, exportable financial reports from reviewed transaction data — for tax filing, business accounting, auditing, or personal reference. Reports are always backward-looking, always based on approved transactions only, and always saved to Google Drive for persistent access without local file management.

This is the simplest module in the system but one of the most practically important: it's where the work of all the other modules becomes a deliverable someone else can use.

---

### 6.1 Core Principles

- **Reviewed transactions only.** No unreviewed, staged, or projected data — this module is exclusively a view over the finalized transaction ledger.
- **No plan or scenario data.** Reporting is purely historical actuals.
- **Configuration-first.** The core object is a saved **report configuration** (a named set of filters and options). Generating a report for a new time period means selecting a saved config and picking a date range — not rebuilding from scratch every time.
- **Google Drive as the output destination.** Generated files are pushed to Drive and a link is stored in the system. No local downloads required (though export to file remains available as a fallback).

---

### 6.2 Report Configurations

A report configuration is a saved, reusable template. It captures everything except the date range, which is specified at run time.

#### 6.2.1 Configuration Fields

| Field | Description |
|-------|-------------|
| Name | Descriptive, e.g., "Elyse Coaching — Schedule C" or "Whitford House — Annual P&L" |
| Entity filter | One entity, multiple entities, or all |
| Category filter | Specific categories, an aggregated category group, or all |
| Category mode | Tax categories only / budget categories only / both |
| Transaction detail | Include transaction list in output: Yes / No / Optional at run time |
| Output format | Google Sheets (default) / Excel download / both |
| Drive folder | Which Google Drive folder to save outputs to |
| Notes | Any notes about what this config is for or how to use it |

#### 6.2.2 Built-In Starter Configurations
The system ships with pre-built configurations for common use cases. These can be edited to match the user's actual entity names and category setup:

| Config Name | Entity | Category Mode | Notes |
|-------------|--------|---------------|-------|
| Schedule C — Coaching (Elyse) | Elyse Coaching | Tax categories only | Income + expense for Schedule C filing |
| Schedule C — Consulting (Jeremy) | Jeremy Consulting | Tax categories only | |
| Schedule E — Whitford House | Whitford House | Tax categories only | Rental income/expense for Schedule E |
| Family Monthly Summary | All | Budget categories | General household spending overview |
| Annual Family Summary | All | Both | Full-year income and expenses across all entities |

#### 6.2.3 Configuration List View
Main landing page for the module. Shows all saved configurations with:
- Name, entity filter, last generated date
- Quick actions: Generate Report, Edit, Duplicate, Delete
- "New Configuration" button

---

### 6.3 Generating a Report

When the user selects a configuration and hits Generate:

**Step 1 — Date Range**
- Presets: Last Month, Last Quarter, Last Year, YTD, Custom
- Start and end date fields
- Quarter picker (Q1/Q2/Q3/Q4 + year)

**Step 2 — Options Override (optional)**
- Toggle transaction detail on/off for this run (if config has it set to "optional")
- Confirm Drive folder destination
- Report name preview (auto-generated from config name + date range, e.g., "Elyse Coaching — Schedule C — Q1 2026")

**Step 3 — Generate**
- System runs the report and pushes to Google Drive
- Link stored in the Run History (see 6.5)
- Success confirmation with a direct link to open the file

---

### 6.4 Report Output Format

The generated report is a Google Sheet (or .xlsx) with the following structure:

#### Sheet 1: Summary
- Report title (config name + date range)
- Generated on date
- Entity / category filters applied
- For tax reports (Schedule C / Schedule E): categories are mapped to and grouped by **IRS line numbers**. Each line shows the line number, official IRS label, and total amount. This output can be handed directly to an accountant or used as a filing reference.
- For non-tax reports: standard category summary table (one row per category, total, % of total)
- Separate sections for Income and Expenses where both are present
- Net (Income − Expenses) row at the bottom

#### Sheet 2: By Period (if date range > 1 month)
- Same category rows, but broken out by month or quarter
- Columns: one per period, plus Total
- Format mirrors the Spending module table — familiar and scannable

#### Sheet 3: Transaction Detail (if included)
- One row per transaction
- Columns: Date, Description, Amount, Entity, Category, Account, Notes
- Sorted by date within category, or by category then date (user-configurable in the report config)
- Can be used directly as an audit trail or handed to an accountant

#### Formatting
- Auto-formatted: column widths, currency formatting, header rows frozen
- Entity and report metadata in a header block at the top of Sheet 1
- Tab names are human-readable ("Summary," "By Month," "Transactions")

---

### 6.5 Run History

Every generated report is logged:

| Field | Description |
|-------|-------------|
| Configuration name | Which config was used |
| Date range | Start and end dates |
| Generated at | Timestamp |
| Generated by | User |
| Drive link | Direct link to the file in Google Drive |
| Status | Success / Error |

- Run history is accessible from the configuration detail view and from a global "All Reports" list
- Drive links remain active as long as the file exists in Drive
- Re-running the same config + date range creates a new file (with the generation timestamp in the filename) — it does not overwrite

#### File Naming Convention
`{Config Name} — {Date Range} — Generated {YYYY-MM-DD}`

Example: `Elyse Coaching — Schedule C — Q1 2026 — Generated 2026-04-03`

---

### 6.6 Google Drive Integration

- User configures a root Drive folder for report output during initial setup
- Each report configuration can optionally specify a sub-folder (e.g., "Tax Documents/2026")
- Sub-folders are created automatically if they don't exist
- The system uses the existing Google Drive MCP connection for file creation
- On generation, the file link is returned and stored in the run history

---

### 6.7 Data Model Additions

| Table | Key Fields |
|-------|------------|
| `report_configs` | id, name, entity_ids (JSON), category_ids (JSON), category_group_ids (JSON), category_mode, include_transactions, output_format, drive_folder_id, notes |
| `report_runs` | id, config_id, start_date, end_date, generated_at, drive_link, file_name, status, error_message |

---

### 6.8 Open Questions

1. **Schedule C / E format compliance** — Should the report try to mirror the actual IRS Schedule C/E line structure (categorizing rows by the official line numbers), or is a clean category summary sufficient for the accountant to work from?
2. **Multi-year comparisons** — Would it be useful to have a "Year over Year" report type that shows the same category set across two or three years side by side? (E.g., Whitford House 2024 vs. 2025 P&L)
3. **Accountant sharing** — Should there be a "share" action that generates a link to the Drive file and pre-drafts an email to a configured accountant contact?
4. **Unreviewed transaction warning** — If unreviewed transactions exist within the report date range, should the report generation be blocked, warned, or silently proceed? (Recommend: warn with count + link to review, but allow proceeding.)

---

## Appendix A: Data Model Summary

*(See individual module sections for full table definitions. This appendix provides a cross-module overview.)*

**Module 1 (Gather):** `accounts`, `raw_transactions`, `sync_log`

**Module 2 (Review):** `transactions`, `transaction_splits`, `rules`, `categories`, `entities`, `knowledge_file`, `postmortem_runs`

**Module 3 (Planning):** `plans`, `plan_category_amounts`, `plan_category_changes`, `plan_one_time_items`

**Module 4 (Spending):** `category_groups`, `category_group_members`, `spending_views`

**Module 5 (Net Worth & Scenarios):** `balance_sheet_accounts`, `account_rate_schedule`, `account_balance_history`, `account_cost_basis_lots`, `account_amortization`, `user_profile`, `state_residence_timeline`, `tax_bracket_schedules`, `tax_deduction_config`, `scenarios`, `scenario_snapshots`, `scenario_flags`, `allocation_decisions`

**Module 6 (Reporting):** `report_configs`, `report_runs`

---

## Appendix B: Build Sequencing Recommendation

Suggested order for Claude Code implementation to maximize early usability:

| Phase | Modules | Rationale |
|-------|---------|-----------|
| 1 | Gather + Review (Modules 1–2) | Core data pipeline — nothing else works without this |
| 2 | Reporting (Module 6) | Immediately valuable once transactions are reviewed; simple to build; validates the category/entity model |
| 3 | Spending (Module 4) | Adds the plan-vs-actual layer; more useful once reporting confirms data quality |
| 4 | Planning (Module 3) | Adds the plan layer that Spending compares against |
| 5 | Net Worth / Scenarios — Account Setup + Balance History only | Get the data model in place; visualize historical net worth without the engine |
| 6 | Net Worth / Scenarios — Tax Config + Single-pass engine | Forward projection without optimization |
| 7 | Net Worth / Scenarios — Two-pass optimization + Flags | Full scenario analysis |

---

## Appendix C: Decisions Log

All open questions have been resolved. This appendix is the authoritative record of decisions made.

### Infrastructure
| Decision | Resolution |
|----------|-----------|
| Hosting / runtime | Cloudflare Workers |
| Database | Neon (serverless Postgres) via Cloudflare Hyperdrive — chosen for Scenarios module query complexity; projected usage ~75 MB vs. 500 MB free tier limit |
| File storage | R2 |
| Email parsing | Gmail API (server-side; Cloudflare Worker polls on schedule) |
| File output | Google Drive via MCP |
| Users | Two (Jeremy + Elyse), shared permissions |
| Data hygiene | Raw transaction staging payloads purged after review approval |

### Module 1 — Gather
| Decision | Resolution |
|----------|-----------|
| Chrome Extension distribution | Internal only — load unpacked in developer mode |
| Apple transaction scraping | DOM/scroll approach confirmed; implementation to be verified at build time |

### Module 2 — Review
| Decision | Resolution |
|----------|-----------|
| Entity configuration | Fully user-configurable from settings |
| Category library | Pre-built Schedule C/E tax categories + default budget categories; user can add/edit; categories with assigned transactions cannot be deleted (deactivated only) |

### Module 3 — Planning
| Decision | Resolution |
|----------|-----------|
| Income modeling granularity | Broken out by source (salary, rental, business, investment, SS, other); collapsible to total |
| Long-range forecasting horizon | 20–40 year horizons supported in v1 |
| New category behavior | Auto-added to all existing plans at $0 |
| Archived plans as comparison targets | Active and draft plans only |
| Plan duplication vs. extending | **Duplicate** = sibling with same parent (full independent copy). **Extend** = new child Modification plan. Two distinct UI actions. |

### Module 4 — Spending
| Decision | Resolution |
|----------|-----------|
| Named spending views | Yes — saveable and recallable from dropdown |
| Income display | Separate tab from expenses |
| Entity filtering | Both entity filter and aggregated category groups, independently and combinable |
| Export | Google Sheets output covers this; no separate CSV export needed for v1 |

### Module 5 — Net Worth & Scenarios
| Decision | Resolution |
|----------|-----------|
| Tax engine scope (v1) | Full: ordinary income + LTCG/STCG + NIIT + AMT + QBI deduction + depreciation recapture + state |
| 529 accounts | Supported in v1 with contribution schedule and qualified withdrawal modeling |
| Social Security income | In scope for v1; per-person benefit estimate, elected start age, survivor benefit |
| Roth conversion modeling | In scope for v1; Pass 2 proposes conversions in low-income years with NPV rationale |
| Scenario run model | Async background job; status indicator in UI; in-app notification on completion |
| Sensitivity analysis / range bands | Phase 2 |
| Private equity valuation history | Supported via balance history logging (same mechanism as all accounts) |

### Module 6 — Reporting
| Decision | Resolution |
|----------|-----------|
| Schedule C/E format | IRS line number structure — categories mapped to official line numbers |
| Multi-year comparison report | Phase 2 |
| Unreviewed transaction warning | Warn with count + link to review; allow proceeding |
| Accountant sharing | Drive link is sufficient; pre-drafted email is Phase 2 |



---

## Appendix D: Migration & Integration

*Based on the five-report audit of the existing CFO agent (`apps/cfo`) in the AgentBuilder monorepo, conducted May 2026.*

---

### D.1 Repository Integration

The new system lives as `apps/cfo/` in the existing AgentBuilder monorepo — replacing the cfo app and following identical conventions.

**Directory structure for Claude Code:**
```
apps/cfo/
├── package.json          (workspace deps: @agentbuilder/web-ui-kit, observability, auth-google, llm)
├── wrangler.toml         (bindings: Neon/Hyperdrive, R2, Cloudflare Queue, ASSETS)
├── tsconfig.json
├── tsconfig.web.json
├── vite.config.ts
├── tailwind.config.ts    (copy from apps/cfo — see D.3)
├── migrations/           (Postgres migrations)
└── src/
    ├── index.ts          (Worker entrypoint — same pattern as CFO)
    ├── mcp-tools.ts      (MCP server — same JSON-RPC 2.0 pattern)
    ├── lib/
    └── web/              (React SPA — Vite)
```

**Two corrections vs. CFO that the new system must make:**
1. Use `@agentbuilder/auth-google` for Gmail OAuth — not raw `GOOGLE_OAUTH_*` env vars
2. Use `@agentbuilder/llm` model tiers — not hardcoded model IDs

**CI:** Copy `.github/workflows/deploy-cfo.yml` → `deploy-family-finance.yml`, update the `app` path.
**Registry:** Add entry to `registry/agents.json` once MCP tools are defined.

---

### D.2 Code Reuse Decisions

#### Promote to shared packages (do this first)

| Current location | Target | Adaptation |
|---|---|---|
| `apps/cfo/src/lib/teller.ts` | `packages/teller` | Replace `import type { Env }` with narrow `TellerEnv` interface |
| `apps/cfo/src/lib/dedup.ts` | Inline in new app or `packages/core` | None — pure utilities |

Gmail auth routes through existing `@agentbuilder/auth-google` rather than a new package.

#### Copy into the new app

| Component | Source | Adaptation |
|---|---|---|
| Teller sync algorithm | `src/routes/teller.ts` — pending→posted reconciliation + disconnect-detection | Rewrite DB writes against Postgres; preserve algorithm exactly |
| Email parsers | `src/lib/amazon-email.ts`, `venmo-email.ts`, `apple-email.ts`, `etsy-email.ts` | Use as reference only — rewrite against new gather-only architecture; re-validate against email samples |
| Email match scoring | Score functions from `src/lib/amazon.ts`, `venmo.ts`, `apple.ts`, `etsy.ts` | Extract as pure functions; rebuild store-side against new schema |
| Review interview pattern | `src/lib/review-interview.ts` — `getNextInterviewItem` | Adapt to new schema |
| Rule-learning pattern | `src/lib/learned-rules.ts` — `maybeLearnRuleFromManualClassification` | Adapt to new schema |
| Tool-result truncation | `src/lib/tool-result-truncate.ts` | Copy as-is |
| "Thin wrapper over REST" MCP pattern | `src/mcp-tools.ts` — `dispatchTool` pattern | Apply to new tool set |
| Period prorating math | `src/routes/budget.ts` — cadence normalization | Extract as utility |

#### Rebuild from scratch

| Component | Reason |
|---|---|
| `src/routes/teller.ts` (full file) | Rewrite against Postgres using extracted algorithm |
| All classification/review routes | New Review module architecture is different |
| All budget/plan/reporting routes | New modules replace these |
| `src/lib/sms-*.ts` + SMS tables | Feature dropped |
| `src/routes/plaid.ts` + Plaid tables | Plaid dropped |
| `pre-migration-backup.sql` | Leftover artifact; ignore |

---

### D.3 UI Reuse

#### Copy verbatim

| File | Notes |
|---|---|
| `apps/cfo/tailwind.config.ts` | Update `content` glob only — all design tokens carry over |
| `apps/cfo/src/web/index.css` | No changes |
| `apps/cfo/src/web/main.tsx` | No changes (Sonner toast setup) |
| `apps/cfo/src/web/components/ui.tsx` | No changes — Button, Card, Badge, Select, Input, Drawer, PageHeader, EmptyState |
| `apps/cfo/src/web/router.ts` | Replace RouteId enum with new routes; implementation stays |
| `apps/cfo/src/web/utils/txColor.ts` | No changes — credit/debit sign inversion logic |
| `apps/cfo/src/web/components/TopNav.tsx` | Replace TABS array and brand mark |
| `apps/cfo/src/web/components/ChatPanel.tsx` | Rebind to new streaming format |

Also promote these to `ui.tsx` for the new system: `SummaryStat`, `SortTh`, `ProgressBar`, `Toggle`, `StatusBadgeFromConfidence`.

#### Use as layout reference (rewrite implementation)

| File | What to preserve |
|---|---|
| `ReviewQueueView.tsx` (672 lines) | Bulk-select (visible-page + filtered-set + persistent-across-pages), filter panel, row drawer, propose-rule modal. Best screen in the app — reproduce layout exactly against new schema. |
| `BudgetView.tsx` | SummaryStat grid, per-row progress bar. Split into sub-tabs in new system. |
| `ReportsView.tsx` | IRS-line table structure: stats → income table → expense table → drillable transactions drawer. |
| `IncomeView.tsx` | getPeriodBounds period-nav pattern (← / → annual/quarterly/monthly). Lift as reusable primitive. |

#### Drop entirely

- `ImportsView.tsx` — replaced by Gather module UI
- `AccountsView.tsx` Plaid sections — rebuild without Plaid provider picker
- Legacy SPA at `/legacy`

---

### D.4 Data Migration Plan

**Source:** Production D1 `cfo-db` (id: `7a8081f3-8ae5-4344-8902-5cbd7992670f`).
**Target:** Neon Postgres in the new system.

#### Step 1 — Export from production D1

Run before pausing the old system's cron:

```bash
# Full backup
wrangler d1 export cfo-db --remote --output=cfo-final-$(date +%Y%m%d).sql

# Approved transactions with classifications
wrangler d1 execute cfo-db --remote --command \
  "SELECT t.*, c.entity, c.category_tax, c.category_budget, c.method,
          c.confidence, c.reason_codes, c.is_locked, c.expense_type
   FROM transactions t
   INNER JOIN classifications c ON c.transaction_id = t.id
   LEFT JOIN review_queue rq ON rq.transaction_id = t.id
   WHERE c.review_required = 0
     AND (rq.status = 'resolved' OR rq.id IS NULL)
   ORDER BY t.posted_date DESC" --json > approved-transactions.json

wrangler d1 execute cfo-db --remote \
  --command "SELECT * FROM rules WHERE is_active = 1" --json > active-rules.json

wrangler d1 execute cfo-db --remote \
  --command "SELECT * FROM accounts WHERE is_active = 1" --json > accounts.json

wrangler d1 execute cfo-db --remote \
  --command "SELECT * FROM classification_history" --json > classification-history.json
```

#### Step 2 — Pre-migration data cleaning

1. **Category reconciliation** — Three category sources exist (`chart_of_accounts`, `tax_categories` table, hardcoded constants). Run frequency count on `classifications.category_tax` and `category_budget` values; map to new canonical slugs.
2. **Entity enum normalization** — Map `airbnb_activity` → new Whitford House entity ID; `family_personal` → Personal entity ID.
3. **`category_plaid` column** — Contains Teller categories despite the name. Drop on import.
4. **Amazon JSON fields** — `product_names`/`seller_names` inconsistently typed. Normalize to JSON array before import.

#### Step 3 — Field mapping

| Old field (D1) | New field (Postgres) | Notes |
|---|---|---|
| `transactions.id` | `transactions.id` | Keep TEXT UUID |
| `transactions.posted_date` | `transactions.date` | Cast TEXT → DATE |
| `transactions.amount` | `transactions.amount` | REAL → NUMERIC(12,2) |
| `transactions.description` | `transactions.description` | |
| `transactions.merchant_name` | `transactions.merchant` | |
| `transactions.teller_transaction_id` | `transactions.teller_transaction_id` | |
| `transactions.note` | `transactions.human_notes` | |
| `classifications.entity` | `transactions.entity_id` | Map to new entity table |
| `classifications.category_tax` OR `category_budget` | `transactions.category_id` | Tax takes precedence; map to category table |
| `classifications.method` | `transactions.classification_method` | |
| `classifications.confidence` | `transactions.ai_confidence` | |
| `classifications.reason_codes` | `transactions.ai_notes` | |
| `review_required = 0` | `transactions.status = 'approved'` | |

#### Step 4 — What not to migrate

| Table | Decision | Reason |
|---|---|---|
| `review_queue` (unresolved rows) | Drop | Re-enter via new Teller sync |
| `*_email_processed` dedup tables | Drop | Email parsers rewritten; re-parse from scratch |
| `amazon_orders`, `*_email_matches` | Drop | Re-parsed via new Gather email pipeline |
| `sms_*` tables | Drop | Feature dropped |
| `plaid_*` tables | Drop | Plaid dropped |
| `teller_enrollments.access_token` | Do not migrate value | Re-enroll fresh in new system |
| `imports` | Drop | Re-created by new Teller sync |

#### Step 5 — Account re-linking

Re-enroll Teller accounts fresh in the new system. Do not copy plaintext access tokens. Patelco and EastRise (previously Plaid) handled manually — no auto-sync.

#### Step 6 — Validation before cutover

1. Transaction count within ±5 of old system's approved count
2. `pnl_all_entities` for last 12 months matches within $1/category
3. Schedule C and E totals match
4. Rule count matches active rules on old system

---

### D.5 Transition Strategy

**Overlap period: 2–4 weeks.** Old system in read-only mode; new system is source of truth.

**Before starting new system's first Teller sync:**
- Set `crons = []` in CFO's `wrangler.toml` and redeploy — stops old system pulling new transactions
- Do not run new system's email sync until parser rewrite is validated against samples

**During overlap:** New system runs all syncs. Old system is read-only reference for report diffing.
**Avoid:** Running both systems' email syncs simultaneously. Designate new system as owner of Gmail from day 1.

**Cutover triggers (all four must be true):**
1. One full month-end P&L on new system matches old within $1/category
2. Nightly Teller sync has run 5+ consecutive nights without failure
3. Email parsers validated against real samples of each vendor type
4. User can run Schedule C/E reports on new system without help

**At cutover:** Flip MCP endpoint in Claude.ai to new agent. Old CFO stays deployed (crons empty) as read-only archive for 12 months.

**Final backup before cutover:**
```bash
wrangler d1 export cfo-db --remote --output=cfo-archive-$(date +%Y%m%d).sql
# Retain 7 years (IRS Schedule C/E retention)
```

---

### D.6 Resolved Decisions from Audit

| Question | Decision |
|---|---|
| Plaid integration | Dropped. Patelco and EastRise handled manually. |
| SMS gamification | Dropped entirely. |
| Email dedup tables | Not migrated. Parsers rewritten; all historical emails re-parsed. |
| Email parsing role | Gather-only. Never triggers review completion. Decoupled from classification. |
| `@agentbuilder/auth-google` | New system uses shared package for Gmail auth. |
| `@agentbuilder/llm` | New system uses model tiers, not hardcoded model IDs. |
| Teller mTLS cert | Reuse `certificate_id = "1c40bf07-6ba7-4e8c-b95f-27df8e7adfda"` — already bound in Cloudflare. |
| Legacy SPA | Dropped. |
