# CFO Agent — Audit Report 05: UI Design and Components

Audit date: 2026-05-13
Repository: `jeremystover/AgentBuilder`
Branch: `claude/audit-cfo-agent-pBl92`
Target: `apps/cfo/src/web/` and `apps/cfo/public/` — the React SPA bound to `/` by the `[assets]` directive in `wrangler.toml`.

This report is a design-and-component inventory, not a functional audit. The focus is on what looks coherent and worth carrying into the new system, not whether each screen's business logic is right.

**One note up front.** I have read the source files but cannot render the UI. Visual descriptions below are reconstructed from the Tailwind class names, the design token file, the icon imports, and the layout JSX. They describe what the code says the UI looks like; if the screenshots in a browser surprise you, trust the screenshots, not me.

---

## 1. Tech Stack & Build

### Framework

- **React 18.3** + **TypeScript 5.6**.
- Single-page app (SPA). Uses `React.StrictMode` and `createRoot` (`src/web/main.tsx`).
- A hand-rolled hash router (`src/web/router.ts`, 49 lines) — no `react-router`. Ten string routes, zero dynamic params.

### Styling

- **Tailwind 3.4** with a small custom theme (`apps/cfo/tailwind.config.ts`).
- **Lucide React** (`lucide-react ^0.468.0`) for icons. Consistent stroke style, used at `w-3.5 h-3.5` (inline), `w-4 h-4` (buttons/headers), `w-5 h-5` (primary), `w-10 h-10` (empty-state hero).
- **Sonner** (`sonner ^1.7.0`) for toast notifications. `richColors` + `closeButton` enabled at root (`main.tsx:13`), positioned bottom-right.
- No CSS-in-JS, no CSS modules, no component library (no Radix, no shadcn, no Headless UI). The closest the app comes to a primitive set is `src/web/components/ui.tsx` (129 lines).
- One small global stylesheet `src/web/index.css` (19 lines) — Tailwind base + a thin scrollbar utility class + `::selection` color.

### Build

- **Vite 5.4** (`apps/cfo/vite.config.ts`) builds the SPA. Output: `apps/cfo/dist/` containing `index.html` + hashed `/assets/*.js`/`.css`.
- The Vite config also copies `apps/cfo/public/` (favicons, manifest, `legacy.html`) into `dist/` verbatim.
- **Vitest 2.1** is installed; only one test file exists across the repo (`src/lib/tool-result-truncate.test.ts`), and it is not a UI test.
- Build invoked via `pnpm web:build`. The Worker's deploy command is `pnpm web:build && wrangler deploy`. CI's reusable `_deploy-agent.yml` runs `pnpm run --if-present web:build` before `wrangler deploy`.

### Where the frontend lives

- **Same repo, same Worker, same deploy as the API.** Vite-built bundle is shipped as static assets via `[assets] directory = "./dist" binding = "ASSETS"` in `wrangler.toml`. Cloudflare serves the static files directly; the Worker's `fetch` handler falls through unmatched GETs to `env.ASSETS.fetch(new Request(new URL('/index.html', request.url).toString(), request))` (`src/index.ts:453-461`).
- No CDN, no R2 for assets, no separate Pages project. The SPA shell is cookie-gated by `@agentbuilder/web-ui-kit`'s `requireWebSession` before `env.ASSETS.fetch` is invoked.

---

## 2. Design System Inventory

### Tailwind config (verbatim)

`apps/cfo/tailwind.config.ts`:

```ts
import type { Config } from "tailwindcss";

// Design tokens for the CFO web UI. Light "ledger paper" theme — a CFO
// audience expects something closer to a financial dashboard than a dark
// notebook, so we diverge from research-agent's Lab here. Indigo accent
// kept for cross-product consistency.
export default {
  content: ["./src/web/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary:  "#F8FAFC",
          surface:  "#FFFFFF",
          elevated: "#F1F5F9",
        },
        border: {
          DEFAULT: "#E2E8F0",
          strong:  "#CBD5E1",
        },
        text: {
          primary: "#0F172A",
          muted:   "#64748B",
          subtle:  "#94A3B8",
        },
        accent: {
          primary:  "#4F46E5",
          success:  "#059669",
          warn:     "#D97706",
          danger:   "#DC2626",
        },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
} satisfies Config;
```

### Color palette (every value used in the UI, by role)

The palette is a hand-curated subset of Tailwind's Slate (neutrals) + a small set of accents. **Every UI surface uses these token names, not raw Tailwind classes** — that consistency is one of the strongest aspects of the design.

| Role | Token | Hex | Tailwind equivalent |
|---|---|---|---|
| Page background | `bg-primary` | `#F8FAFC` | slate-50 |
| Card surface | `bg-surface` | `#FFFFFF` | white |
| Subtle / table-header / pressed | `bg-elevated` | `#F1F5F9` | slate-100 |
| Border default | `border-DEFAULT` | `#E2E8F0` | slate-200 |
| Border strong | `border-strong` | `#CBD5E1` | slate-300 |
| Text primary | `text-primary` | `#0F172A` | slate-900 |
| Text muted (labels, secondary) | `text-muted` | `#64748B` | slate-500 |
| Text subtle (placeholders, hints) | `text-subtle` | `#94A3B8` | slate-400 |
| Accent / brand / primary action | `accent-primary` | `#4F46E5` | indigo-600 |
| Success (income, on-track, accept) | `accent-success` | `#059669` | emerald-600 |
| Warning (near-budget) | `accent-warn` | `#D97706` | amber-600 |
| Danger (over-budget, expense, destroy) | `accent-danger` | `#DC2626` | red-600 |
| Selection highlight | inline in `index.css` | `#4F46E5` background, white text |  |

The four accents are used at three densities: full saturation for primary actions, `/10` for "soft" tinted badges and notifications, `/20` for `border-` overlays on info banners, `/40` for danger card outlines (`border-accent-danger/40 bg-accent-danger/5`).

There is **no dark mode** in the SPA. The header comment explicitly chooses a "light ledger paper" theme.

### Typography

- **Font families:** `font-sans` is the system stack (`ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`). `font-mono` is configured but not used in the SPA components. No web fonts loaded.
- **Body text:** `text-sm` (14 px). The dominant size.
- **Small / muted text:** `text-xs` (12 px). Used for table column headers, secondary lines, helper text.
- **Tiny labels:** `text-[11px]` (custom) in the SnapshotPanel section headers (`uppercase tracking-wider`).
- **Headings:**
  - `h1` page title: `text-xl font-semibold text-text-primary` (~20 px). `PageHeader` component.
  - `h2` section / subsection: `text-sm font-semibold text-text-primary` (and sometimes `text-lg` for empty-state hero titles).
  - SnapshotPanel section labels: `uppercase tracking-wide` (or `tracking-wider` at the smallest sizes).
- **Stat values:** `text-2xl tabular-nums font-semibold` (`SummaryStat` component, ~24 px). Used for big numbers.
- **Numeric alignment:** `tabular-nums` is applied consistently to dollar amounts, percentages, counts. This is a deliberate small detail that makes financial tables read cleanly.
- **Antialiasing:** `-webkit-font-smoothing: antialiased` set globally in `index.css`.

### Spacing scale

Default Tailwind 4-px scale. Idiomatic uses:
- Card padding: `p-3` (12 px) for compact stats, `p-4` (16 px) for filter cards, `p-6` (24 px) for page containers and empty-state heroes.
- Form fields: `px-3 py-1.5` (input, select), `px-3 py-2` (textarea), `px-2.5 py-1` (small buttons).
- Inter-row spacing in tables: `py-2.5` (10 px).
- Gaps between flex items: `gap-1.5` (6 px, tight chips), `gap-2` (8 px, action clusters), `gap-3` (12 px, side-by-side stats), `gap-5` (20 px, between page sections).
- Page horizontal frame: `max-w-3xl mx-auto` (chat), `max-w-6xl mx-auto` (reports), `max-w-7xl mx-auto` (review queue, transactions).

### Border radius

- Small/utility: `rounded-md` (6 px) — tab pills, nav items, inline note panels.
- Inputs & primary buttons: `rounded-lg` (8 px).
- Cards: `rounded-xl` (12 px).
- Chat bubbles: `rounded-2xl` (16 px).
- Pills/badges/progress bars: `rounded-full`.

### Shadows

Minimal — only used for floating surfaces:
- `shadow-xl` on Drawer (`ui.tsx:91`).
- `shadow-2xl` on the rule-proposal modal (`ProposeRuleModal.tsx:109`).
- `shadow-lg` on the bank-account dropdown menu (`AccountsView.tsx:277`).

Cards themselves have **no shadow** — they rely on a 1 px border + the `bg-surface` lift against `bg-primary`. This is consistent with the "ledger paper" thesis.

### Global stylesheet (verbatim)

`apps/cfo/src/web/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  html, body, #root {
    height: 100%;
    background: #F8FAFC;
    color: #0F172A;
    -webkit-font-smoothing: antialiased;
  }
  ::selection {
    background: #4F46E5;
    color: #FFFFFF;
  }
  .scrollbar-thin::-webkit-scrollbar { width: 6px; height: 6px; }
  .scrollbar-thin::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 3px; }
  .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
}
```

---

## 3. Component Inventory

### 3.1 Primitives — `src/web/components/ui.tsx` (129 lines, 6 components)

| Component | Variants / props | Visual |
|---|---|---|
| `Button` | `variant: 'primary' | 'ghost' | 'success' | 'danger' | 'warn'`; `size: 'sm' | 'md'`. Accepts standard `ButtonHTMLAttributes`. | Indigo fill for primary, transparent + slate border for ghost, accent fills for success/danger/warn. `rounded-lg`, `inline-flex items-center gap-1.5`. Hover: `opacity-90`. Disabled: `opacity-40`. |
| `Card` | `className` passthrough, `children`. | `rounded-xl border border-border bg-bg-surface`. No padding by default — caller adds. |
| `Badge` | `tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'info'`. | `rounded-full px-2 py-0.5 text-xs font-medium`. Filled-but-soft (`bg-accent-xxx/10 text-accent-xxx`) for the tinted tones, slate for neutral. |
| `Select` | Standard `SelectHTMLAttributes`. | `rounded-lg border` matching `Input`. Focus ring `focus:ring-2 focus:ring-accent-primary`. |
| `Input` | Standard `InputHTMLAttributes`. | Same as Select. |
| `Drawer` | `open`, `onClose`, `title: ReactNode`, `children`, `footer?`. | Right-anchored side panel, `max-w-xl`, full height. Backdrop `bg-black/30`. Header `border-b` + title + close `✕`. Optional footer in `bg-elevated`. `shadow-xl`. |
| `PageHeader` | `title: string`, `subtitle?`, `actions?: ReactNode`. | Flex justify-between, title `text-xl font-semibold`, subtitle `text-sm text-text-muted`, actions cluster on the right. `mb-5`. |
| `EmptyState` | `children`. | Centered, `py-10 text-text-subtle text-sm`. Used inside table bodies for "Nothing in queue.", "Loading…", etc. |

Quality: **clean, reusable, low-coupling.** Each is a thin wrapper over the native element with `className` override available. No state, no portals, no animation libraries. **COPY AS-IS** verdict; the file is 129 lines and depends only on React + Tailwind.

Plus two utilities exported from the same file:
- `fmtUsd(n, { sign? })` — formats dollars; returns `—` for null, optional `+`/`−` sign prefix.
- `humanizeSlug(s)` — replaces underscores with spaces.

### 3.2 `TopNav` — `src/web/components/TopNav.tsx` (59 lines)

- Horizontal bar across the top of the app. `border-b`, white surface, `px-5 py-2`, sticky (`shrink-0` inside the flex column).
- Left: brand cluster (`Wallet` icon at `text-accent-primary` + the literal text "CFO" at `font-semibold text-base`), separated by a vertical `border-r` from the nav.
- Nav: 10 horizontal tabs, each an `inline-flex` of icon + label. Active tab uses the soft brand tint (`bg-accent-primary/10 text-accent-primary`); inactive uses `text-text-muted` with `hover:bg-bg-elevated`. `rounded-md` pills.
- Right: secondary links (`Legacy UI`, `Sign out`) at `text-xs text-text-muted`.
- Icons used: `Wallet`, `MessageSquare`, `Inbox`, `Building2`, `Receipt`, `FileText`, `Upload`, `Filter`, `PiggyBank`, `TrendingUp`, `Settings`.
- **Quality:** clean. The whole pattern would carry to the new system with a different `TABS` array. **COPY AS-IS** (minor adaptation: replace the `RouteId` enum and `useRoute` hook with the new router).

### 3.3 `SnapshotPanel` — `src/web/components/SnapshotPanel.tsx` (147 lines)

Right sidebar widget on the Chat layout. ~320 px wide, full-height, `border-l bg-bg-surface`.

- Header: `Snapshot` label + `RefreshCw` icon button. Header label is `text-sm font-semibold uppercase tracking-wide`.
- Sections (each a `Section` sub-component): tiny `[11px] uppercase tracking-wider` overline above an inset card (`rounded-lg border bg-bg-surface p-3`).
  - Review queue: shows count as a big `text-2xl font-semibold` + "items need attention" caption.
  - P&L · {period_label}: three rows — Income (green), Expense (default), Net (bold, green or red by sign).
  - Budget · {period_label}: up to 6 lines, each row = category name + `%` + a horizontal progress bar.
- Progress bar: `h-1.5 rounded-full bg-bg-elevated overflow-hidden`, inner fill width = `min(pct*100, 100)%`. Color logic: `> 100% → accent-danger`, `> 85% → accent-warn`, else `accent-primary`.
- Error state: `border-accent-danger/40 bg-accent-danger/5 p-3` with `AlertTriangle` icon.
- Loading: simple `text-xs text-text-subtle` "Loading…" line.

**Quality:** very clean. Encapsulated, no global deps. Visual style is the cleanest in the app. **COPY AS-IS** (just rebind to the new system's snapshot endpoint). **HIGH** carry-forward value.

### 3.4 `ChatPanel` — `src/web/components/ChatPanel.tsx` (145 lines)

Center column of the Chat layout. Bubble-style chat.

- User turns: right-aligned `rounded-2xl bg-accent-primary px-4 py-2.5 text-sm text-white whitespace-pre-wrap`, `max-w-[80%]`.
- Assistant turns: left-aligned `rounded-2xl bg-bg-surface border border-border px-4 py-3 text-sm text-text-primary`.
- Streaming placeholder: `"Thinking…"` in `text-text-subtle italic`.
- Tool-call pills: small `rounded-full px-2 py-0.5 text-xs` pills under the assistant message, colored by status (`running` → soft indigo, `error` → soft red, default → soft green).
- Composer: bordered top section, `max-w-3xl mx-auto`. Textarea (rows=2) + Send button (indigo fill) or Stop button (red fill) when streaming, plus a trash-can clear button when there's a conversation. Enter sends; Shift+Enter newlines.
- Empty state: centered `Wallet` icon at `w-10 h-10 text-accent-primary` + "CFO" title + example-question copy.

**Quality:** polished. Same bubble pattern used in many production AI chat UIs. The streaming-tool-pills affordance is a thoughtful detail. **COPY AS-IS** as the new system's chat surface if a chat surface is in scope.

### 3.5 `ReviewQueueRail` — `src/web/components/ReviewQueueRail.tsx` (83 lines)

Left sidebar widget on the Chat layout. 288 px (`w-72`).

- Header link: "Review queue" `uppercase tracking-wide` + `Inbox` icon + total pending below.
- Body: up to 3 items as left-aligned summary cards (`hover:bg-bg-elevated rounded-md px-2 py-2`). Each shows merchant on the left, signed dollar on the right, suggested category below in `text-text-subtle`.
- "View all N →" link in `accent-primary` at the bottom.
- Empty state: "All caught up. 🎉".
- Loading: `text-xs text-text-subtle` "Loading…".

**Quality:** clean and characterful (the 🎉 in empty state). The pattern — sidebar widget summarising a queue with a click-through to the full screen — is reusable. **COPY AS-IS** for any "what needs my attention" widget.

### 3.6 `ReviewQueueView` — `src/web/components/drilldowns/ReviewQueueView.tsx` (672 lines)

**This is the most important component in the app for the new Review module.** Full screen. See §8 for the table treatment. Headline visual elements:

- Top: `PageHeader` with subtitle showing the current filter state ("N pending items (uncategorized)"), action cluster on the right containing a `"Suggest rules"` switch toggle, a `"Classify unclassified"` primary button (sparkle icon), and a refresh button.
- "Classify" inline scope picker: when the user clicks Classify, the action area swaps to three buttons — "This page (N)", "All unclassified (N)", "Cancel".
- Running banner: rounded indigo soft-tinted card with `Loader2` spin + status text + "This may take 30–60 seconds for large batches" right-aligned hint.
- Three-card stack:
  1. **Filters card** — three controls (Status, Category, Search) in a `flex-wrap` row, each with a `text-xs text-text-muted` label above.
  2. **Bulk actions card** — two-row layout: top row is a description + selection helpers (Select visible, Select filtered (N), Clear); bottom row is the destructive/constructive action buttons (Accept selected, Reopen selected, Reclassify selected) plus inline entity+category dropdowns.
  3. **Data table card** (`overflow-hidden` wrapping `overflow-x-auto`) — header row in `bg-bg-elevated` with `uppercase tracking-wide text-xs text-text-muted` column headers; checkbox column; sortable columns with `Chevron` indicators.
- Per-row "Open" button on the right opens the **Review Drawer** (a `Drawer` from the primitives module): definition list of metadata at the top, "Why this is in the queue" `<pre>` block, "What I need from you" paragraph, then a 2×2 grid of selects (Entity, Tax category, Budget category, Cut tracking), with a footer of six buttons (Skip, Transfer, Reclassify (sparkle), Cancel, Accept suggestion (green), Apply override (indigo primary)).
- "Suggest rule" follow-on modal: after a manual classify, if the toggle is on, opens `ProposeRuleModal` (a centered modal with `shadow-2xl rounded-xl max-w-lg bg-bg-surface border`) to propose a deterministic rule from the merchant.

**Quality:** **the most refined screen in the codebase.** Three nested affordances (filter → bulk → drill-in drawer → propose-rule modal) are visually consistent and don't bury the user.

### 3.7 `ProposeRuleModal` — `src/web/components/ProposeRuleModal.tsx` (225 lines)

Centered modal, `rounded-xl shadow-2xl border max-w-lg`, on a `bg-black/30` backdrop. Form fields: rule name (`Input`), match field (`Select`), match operator (`Select`), match value (`Input`), entity (`Select`), tax category (`Select`), budget category (`Select`), priority (`Input` number), an "apply retroactively" checkbox. Footer: Dismiss / Add rule.

The reusable bit here is `buildRuleProposal(...)` — a pure helper that constructs a sensible `RuleInput` draft from a merchant decision.

### 3.8 `SummaryStat` (defined twice)

Defined once in `BudgetView.tsx:529` and again in `ReportsView.tsx:465`. Both render a `Card p-3` with a `text-xs text-text-muted` label above a `text-2xl tabular-nums font-semibold` value. The BudgetView variant supports `tone: 'neutral' | 'ok' | 'warn' | 'danger'`; the ReportsView variant takes a `valueCls?` className override.

This is the **most reused pattern in the screens** and should be promoted to `ui.tsx` in the new system.

### 3.9 BudgetView's per-row progress bar (lines 558–633)

The `BudgetRow` component renders a row with a flex-aligned progress bar in one cell:

- 100%-wide track: `h-2 rounded-full bg-bg-elevated overflow-hidden`.
- Inner fill: width = `min(pct, 100)%`, color: `accent-danger` when over, `accent-warn` when near, `accent-success` when under, `bg-elevated` (no fill) when no target.
- Percentage label `text-xs tabular-nums text-text-muted w-12 text-right` next to the bar.

**Quality:** the SnapshotPanel and BudgetView use **almost the same** progress bar logic with slightly different thresholds and color choices. Worth consolidating into a `<ProgressBar>` primitive when carrying forward.

### 3.10 Toggle switch (inline, ReviewQueueView lines 232–246)

A small role=switch toggle, not yet a primitive. `relative inline-flex h-5 w-9 items-center rounded-full` with `transition-colors` to indigo when on; the thumb is a `h-3.5 w-3.5 rounded-full bg-white` with `translate-x-` transform. Persisted to `localStorage.cfo_suggest_rules`.

Worth promoting to a primitive — toggles will appear all over the new app.

### 3.11 Sortable `<th>` (defined twice)

Two copies in `ReviewQueueView.tsx:19-36` and `TransactionsView.tsx:20-36`. Renders an `<th>` with a label and a `ChevronUp` / `ChevronDown` icon at `opacity-25` when inactive, `opacity-100` when sorting. Hover: `text-text-primary`.

**Quality:** clean, copy-pasted. Should be promoted to a primitive.

### 3.12 Inline icon usage summary

Used across every screen, from `lucide-react`:

`Wallet, MessageSquare, Inbox, Building2, CreditCard, Receipt, FileText, Upload, Filter, PiggyBank, TrendingUp, Settings, Send, Square, Trash2, RefreshCw, AlertTriangle, ArrowLeftRight, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Sparkles, Loader2, Plus, Pencil, Check, X, Target, FileUp, ShoppingCart, Database, Lock, Download, Calculator`.

**No emoji icons** beyond the single 🎉 in the empty review-queue rail.

---

## 4. Page / Screen Inventory

The router (`router.ts`) enumerates 10 routes. The "config" route is the catch-all settings screen. All routes are hash-based (`#/review`, `#/transactions`, etc.).

### 4.1 `#/` (`#/chat`) — Chat

- Layout: **three-column split.** Left: `ReviewQueueRail` (288 px, hidden below `lg`). Center: `ChatPanel` (flex-1). Right: `SnapshotPanel` (320 px, hidden below `md`).
- Pattern: bubble chat + sidebar widgets.
- Works well: dense, focused, no clutter; the snapshot and review rail provide context the user wouldn't have to ask for.
- Unfinished: the two sidebars are hidden entirely on small screens; no mobile equivalent.
- **Maps to (new system module):** Conversational / Chat module.

### 4.2 `#/review` — Review Queue

- Layout: single full-width page, `p-6 max-w-7xl mx-auto`.
- Pattern: PageHeader → filters card → bulk-actions card → table → pagination → drawer.
- Works well: the **stacked-card vertical flow** keeps each stage visually distinct. The bulk-actions card explicitly tells the user how many are selected and what scope ("all N filtered" vs "M selected"). The drawer-with-footer-action-cluster is the strongest CTA pattern in the app.
- Unfinished: nothing visibly. This screen is the most polished.
- **Maps to: Review module — directly.** This is the screen the new system should clone first.

### 4.3 `#/transactions` — Transactions

- Layout: same shell as Review Queue.
- Pattern: PageHeader + Filters card (with date-range pickers and many filters) + Table with selection + Drawer.
- Works well: rich filter set, sortable columns, color-coded amounts via `txAmountColor`.
- Notable: the `txAmountColor` util encodes a subtle invariant — credit-card accounts invert the sign convention (positive amount = balance owed up = red).
- **Maps to: Ledger / Transactions module.**

### 4.4 `#/accounts` — Accounts

- Layout: page with bank-connect call-to-action at the top (a dropdown of Teller / Plaid options) + grouped list by institution.
- Pattern: each institution becomes a section header (`Building2` icon + name), and accounts within are cards with `CreditCard` icons, an `owner_tag` `Select`, a `RefreshCw` re-sync button, and a Plaid/Teller scripted-load flow that pops the bank's own modal.
- **Maps to: Accounts / Connections module.**

### 4.5 `#/imports` — Imports

- Layout: page with three uploader cards at top (CSV, Amazon, Tiller) + a history table below.
- Pattern: visual upload-card pattern not yet generalised — each is its own JSX.
- **Maps to: probably retired in the new system** (per Report 04 §2; Tiller import is one-time, Amazon import overlapped by Gmail pipeline).

### 4.6 `#/rules` — Rules

- Layout: same page-card-table shape.
- Pattern: rules list with sortable columns, inline edit (Pencil icon → form swap), bulk import from Tiller's AutoCat.
- **Maps to: Rules / Automation module.**

### 4.7 `#/budget` — Budget

- Layout: longest page in the app — multiple stacked panels:
  1. Period picker (PRESETS + custom date range).
  2. `BudgetForecastPanel` (collapsible Anticipated Expenses with `SummaryStat` row + drilldown table).
  3. `CutsPanel` (Cuts report stats).
  4. Three top-line `SummaryStat`s (Total target / Spent / Remaining) in a 3-column grid.
  5. The big Budget table (per-category target / spent / remaining / used (with bar) / status).
  6. Drawers for budget transactions, target editor, new category, and a budget-history modal with a calculator affordance.
- Works well: progressive disclosure (forecast and cuts collapsed; "show categories without targets" toggle), the per-row inline progress bar.
- Unfinished: the page is **very tall** with at least 6 distinct sections — even though each is well-styled, the overall page lacks an anchor / sub-tabs.
- **Maps to: Budget / Planning module.**

### 4.8 `#/income` — Income

- Layout: PageHeader (with period nav arrows ←/→) + stat grid + per-entity rows + target editor drawer.
- Pattern: similar to Budget but for income targets per entity.
- **Maps to: Income / Goals module.**

### 4.9 `#/reports` — Reports

- Layout: PageHeader with year selector + tab pills (Schedule C — Elyse / Schedule C — Jeremy / Schedule E — Whitford / Summary) + the selected report.
- Pattern: each Schedule view shows three `SummaryStat`s (income / expenses / net) at top, then per-IRS-line tables for income and expenses, with a clickable line that opens a transactions drawer.
- Visible affordance: a Download button that hits `reportExportUrl(...)` for CSV export.
- **Maps to: Reports / Statements module.**

### 4.10 `#/config` — Config

- Layout: page with three table sections — Tax categories (Schedule C), Tax categories (Schedule E), Budget categories. Each table is a Card containing an editable list. Below each: an "Add" inline form.
- **Maps to: Settings / Admin module.**

### 4.11 Unknown routes — `ComingSoon`

`App.tsx:68-79` renders a centered "Not ported yet — head to the legacy UI" message for any unrecognised route. This is the only place the legacy SPA is referenced (besides the TopNav link).

---

## 5. Navigation & Layout Patterns

### App shell

`App.tsx:21-39`:

```
<div class="h-screen flex flex-col overflow-hidden">
  <TopNav />                            <!-- fixed top -->
  <div class="flex-1 min-h-0 overflow-y-auto">
    <ActiveRouteView />
  </div>
</div>
```

- **Top nav only**, no sidebar in the shell (the Chat layout's two sidebars are local to that screen).
- Fixed-height root with internal scroll on the main content area. No global footer.
- Mobile: the nav is horizontally scrollable via `overflow-x-auto scrollbar-thin`. Layout doesn't otherwise adapt — the Chat layout hides its sidebars below `lg` and `md`.

### Navigation between sections

- Hash-based: `window.location.hash = "#/review"` etc. The `useRoute` hook subscribes to `hashchange`.
- Active state in `TopNav`: brand-tinted pill (`bg-accent-primary/10 text-accent-primary`).
- No breadcrumbs, no nested routing.

### Consistent page header pattern

`PageHeader` from `ui.tsx` is used on **every** drilldown screen with title + subtitle + actions. The subtitle conveys either count/filter state ("248 pending items") or context ("Tax year 2026"). Actions are a flex-wrap cluster on the right.

This consistency is one of the strongest aspects of the SPA — every screen has the same "you are here, here's how many, here's what you can do" anchor.

### Loading states

- **PageHeader subtitle** flips to "Loading…" while pending.
- **Action button icons** (`RefreshCw`) gain `animate-spin` while loading.
- **In-flight banners** for long operations (e.g. classify run): rounded soft-indigo bar with `Loader2 animate-spin` + status text + duration hint.
- **EmptyState fallback** for tables that are simply waiting for data ("Loading…" inside the table body).

No skeleton screens.

### Error states

- **Error card pattern** (used in `ReviewQueueView`, `IncomeView`, `BudgetView`, `ReportsView`, others): `Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger"` containing the error message.
- **SnapshotPanel** has its own variant with an `AlertTriangle` icon and a softer inline layout.
- **Toast errors** via Sonner: `toast.error(...)` is the consistent call for ad-hoc operation failures.

### Empty states

- **`<EmptyState>` primitive** inside table bodies: centered, `py-10 text-text-subtle text-sm`.
- The Chat empty state is the only non-trivial one (centered icon + title + example prompts).
- The ReviewQueueRail uses "All caught up. 🎉" with the rail still rendered.

---

## 6. Charts & Data Visualization

### No charting library

There is **no charting library installed**. `package.json` does not list `recharts`, `chart.js`, `d3`, `visx`, `nivo`, or any other chart package.

### Chart-like visualisations present

- **Progress bars** are the only data visualisation in the app. Two instances:
  - SnapshotPanel `BudgetRow` (h-1.5).
  - BudgetView main table `BudgetRow` (h-2 with percentage label).
  Both implemented as pure CSS divs.
- **Sortable column indicators** (`ChevronUp/Down`) — not a chart, but a data-affordance worth noting.
- **Numeric tables with tabular-nums alignment** carry most of the visual data work.

### Worth noting

For a financial app, the **complete absence of charts** is a deliberate-feeling choice — the tables and SummaryStat cards do the work. If the new system needs charts (P&L over time, budget trends, cash-flow forecast), they will be net-new and a charting library decision will be required. There is nothing to carry forward.

---

## 7. Forms & Input Patterns

### How forms are styled

- All form controls (`Input`, `Select`) use the same primitive: `rounded-lg border border-border bg-bg-surface px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary`.
- Labels: `<label class="block text-xs text-text-muted mb-1">…</label>`. Some places use `text-[11px]` for tighter inline groups.
- Checkboxes: native `<input type="checkbox" />` without custom styling. They show the browser default.
- Toggles: custom inline (see §3.10).

### Validation

- **No inline field-level validation.** Errors surface through `toast.error("Name and match value are required")` (e.g. `ProposeRuleModal.tsx:71`).
- The drawer-based forms (review drawer, target editor, propose-rule modal) prevent commit at the button level (`disabled={...}` based on minimum-required field presence), e.g. `disabled={busy || !bulkCategory || (!selectedAllFiltered && selectedCount === 0)}`.

### Selects

Native `<select>` with the shared `rounded-lg border` style. No combobox, no virtual list, no search. Category dropdowns enumerate via `useCategoryOptions`.

### Date pickers

**Native `<input type="date" />`** with the same shared `rounded-lg border` style. No custom date picker library. Five instances in the codebase (TransactionsView filters, BudgetView custom-period inputs, BudgetView target editor).

### Notable patterns

- The **PageHeader actions cluster** doubles as a sub-form: e.g. in ReviewQueueView the "Suggest rules" toggle, the year/period picker, and the action buttons all live in the same right-aligned flex row.
- The **inline editable row pattern** in ConfigView: a row's edit icon swaps the cells for inputs and the row gains save/cancel icons. Looks like good lightweight admin UX.
- The **filter card** pattern (a flex-wrap row of labeled controls inside a Card) is used in every list screen.

Nothing here is bespoke enough to be hard to recreate — but the **consistent styling discipline** is worth preserving (no third-party UI lib means no upgrade hell).

---

## 8. Tables & Lists

This is the most important section for the new Review module. Tables are everywhere in the app and they share a remarkably consistent pattern.

### Table style

All tables follow the same skeleton:

```tsx
<Card className="overflow-hidden">
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-text-muted uppercase tracking-wide border-b border-border bg-bg-elevated">
          <th className="pl-4 py-2">…</th>
          …
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr className="border-b border-border last:border-b-0 hover:bg-bg-elevated/50">…</tr>
        ))}
      </tbody>
    </table>
  </div>
</Card>
```

- `Card overflow-hidden` + inner `overflow-x-auto` = a card-shaped table with horizontal scroll on small screens.
- Headers: `bg-elevated`, `text-xs text-text-muted uppercase tracking-wide`. Cells `py-2` / rows `py-2.5`.
- `hover:bg-bg-elevated/50` for row hover.
- `border-b last:border-b-0` for row separators.
- Numeric columns: `text-right tabular-nums`.

### Sorting

- Per-column `<SortTh>` (defined twice; see §3.11).
- Click to sort, click again to toggle direction. Up/down chevron is shown faintly when inactive.
- `setOffset(0)` is called on sort change so pagination resets.

### Filtering

- Filter card above the table. Status / Category / Account / Date-range / Search inputs.
- Search uses `setTimeout` for 400 ms debounce.

### Pagination

```
Showing 1–50 of 248 [← Prev] [Next →]
```

- Render outside the Card, in a flex row at `text-sm text-text-muted`.
- Prev/Next buttons disabled at edges. No page-number picker.

### Row actions

- **Per-row action button** on the right (`Open` for review/transactions, `Pencil` for inline edit in config).
- **Drawer-opening rows** (review, transactions): the whole row is the trigger; the right-most cell contains an explicit button as a click target.
- **Inline checkboxes** for bulk selection (leftmost cell).
- **Inline actions for trivial mutations** (`Trash2` for delete, `Check` for save, etc.) — never modal-confirmed; uses `window.confirm`. This is consistent but rough; the new system might prefer a soft-confirm dialog.

### Bulk actions

The ReviewQueueView is the only screen with a full bulk-actions card. It implements three layered ideas worth carrying:

1. **Visible-page select-all** with `indeterminate` checkbox state when partial.
2. **Filtered select-all** (a separate explicit button: "Select filtered (N)"), which flips `selectedAllFiltered` and sends `apply_to_filtered=true` to the API instead of an array of IDs.
3. **Persistent selection across pagination**: selection state is a `Set<string>` kept in component state, not per-page.

This is the single most useful pattern in the SPA for a Review module. **COPY AS-IS** — it solves the "I want to bulk-accept 1,400 ambiguous items" problem without making the UI lie about scope.

### Color treatment for amounts

The `txAmountColor(amount, accountType, categoryTax)` utility (`src/web/utils/txColor.ts`, 19 lines) encodes the credit-card sign inversion (positive amount on a credit account = expense = red). Transfers get the default text color (neutral). This is a small invariant easy to miss in a rewrite.

### Confidence badge

In `ReviewQueueView` rows, the AI confidence is rendered as a `Badge` with tone derived from value:

```ts
conf == null ? "neutral" :
conf >= 0.9 ? "ok" :
conf >= 0.7 ? "warn" : "danger"
```

Worth keeping.

---

## 9. Copy Candidates

These are files I would copy into the new project as the starting point. Paths are absolute from repo root; file sizes are from `wc -l`.

### Tier 1 — copy verbatim into the new repo

| File | Lines | Contents | Adaptation needed |
|---|---|---|---|
| `apps/cfo/tailwind.config.ts` | 39 | Full design token set: colors (bg/border/text/accent), font families. | Update `content` glob to the new app's path. |
| `apps/cfo/src/web/index.css` | 19 | Tailwind directives + global body styles + scrollbar-thin utility + `::selection`. | None. |
| `apps/cfo/src/web/main.tsx` | 15 | React root + `Toaster` setup with `richColors` / `closeButton` / `position="bottom-right"`. | None (or change toast position if desired). |
| `apps/cfo/src/web/index.html` | 23 | Vite entry HTML + favicons + manifest + theme-color + apple-mobile metadata. | Change `<title>`, `application-name`, `apple-mobile-web-app-title`. Rebrand favicons (currently `/favicon.svg`, etc.; see `apps/cfo/public/` and `apps/cfo/scripts/gen-icons.py`). |
| `apps/cfo/src/web/components/ui.tsx` | 129 | `Button`, `Card`, `Badge`, `Select`, `Input`, `Drawer`, `PageHeader`, `EmptyState`, `fmtUsd`, `humanizeSlug`. | None. |
| `apps/cfo/src/web/router.ts` | 49 | Hash-based router + `RouteId` enum + `useRoute` hook. | Replace `RouteId` with the new app's route set; the implementation stays. |
| `apps/cfo/src/web/utils/txColor.ts` | 19 | Credit-vs-depository sign inversion logic for transaction amounts. | None. |
| `apps/cfo/src/web/components/TopNav.tsx` | 59 | Top nav shell + brand mark + 10-tab nav + right-side actions. | Replace `TABS` array with the new app's routes; replace `<Wallet />` and the "CFO" literal with the new brand. |
| `apps/cfo/src/web/components/SnapshotPanel.tsx` | 147 | The three-section snapshot widget. | Rebind the `snapshot` prop type to the new system's response shape; the layout and styling are general-purpose. |
| `apps/cfo/src/web/components/ChatPanel.tsx` | 145 | Bubble chat + composer + tool-call pills. | Rebind `RenderTurn` type to the new system's streaming format; the rendering is general. |
| `apps/cfo/src/web/components/ReviewQueueRail.tsx` | 83 | Sidebar "next 3 pending" widget. | Rebind the `ReviewItem` shape and the link target; the visual is reusable. |
| `apps/cfo/public/` (icons + manifest) | — | Branded favicon set + maskable PWA icons + manifest.webmanifest. | Re-generate from new branding via `apps/cfo/scripts/gen-icons.py` (a Python helper). |

### Tier 2 — copy as a reference, expect a rewrite against new data shapes

| File | Lines | Why it's worth referencing |
|---|---|---|
| `apps/cfo/src/web/components/drilldowns/ReviewQueueView.tsx` | 672 | The cleanest, most polished screen. Filter / bulk-actions / table / drawer / propose-rule modal pattern. Reproduce the layout against the new schema. |
| `apps/cfo/src/web/components/drilldowns/TransactionsView.tsx` | (~510) | Filter set and table pagination. |
| `apps/cfo/src/web/components/drilldowns/BudgetView.tsx` | (~910) | Per-row progress-bar pattern; the `SummaryStat` grid + collapsible forecast / cuts panels; the budget-history "calculator" modal. |
| `apps/cfo/src/web/components/drilldowns/ReportsView.tsx` | (~470) | Schedule C/E layout with per-line drilldown into transactions. |
| `apps/cfo/src/web/components/ProposeRuleModal.tsx` | 225 | Centered-modal pattern + `buildRuleProposal` helper. |

### Promote-to-primitive candidates

Currently inline or defined twice; should land in `ui.tsx` for the new system:

- `SummaryStat` (used 8+ times across two files — `BudgetView.tsx` and `ReportsView.tsx`).
- `SortTh` (used 2× — `ReviewQueueView.tsx`, `TransactionsView.tsx`).
- `ProgressBar` (the budget-row bar pattern, used 2× with slightly different thresholds — SnapshotPanel and BudgetView).
- `Toggle` (the inline switch in ReviewQueueView lines 232–246, persisted to localStorage).
- `StatusBadgeFromConfidence` (the confidence-to-tone mapping in ReviewQueueView rows).

---

## 10. What to Rebuild

These screens look nice but are tightly coupled to the CFO data model or have structural issues that wouldn't survive transcription.

### 10.1 ReviewQueueView — preserve structure, rewrite implementation

The 672-line file references at least eight CFO-specific bindings: the four-entity enum (`elyse_coaching | jeremy_coaching | airbnb_activity | family_personal`), the cut-tracking enum, the Schedule-C/E categories, the rules table, the `reclassifyWithAI` debug-mode that dumps prompt + raw response to `console.group`. **Carry forward the layout and the bulk-selection pattern; rewrite the body against the new Postgres schema.**

### 10.2 BudgetView — split into smaller screens

The single Budget screen contains six distinct sub-features (status table, forecast panel, cuts panel, target editor, new category drawer, history calculator). The visual treatment is good but the page itself is long. The new system might benefit from anchoring this with sub-tabs (Status / Forecast / Cuts / Categories) or splitting Cuts onto its own screen.

The `BudgetForecastPanel`, `CutsPanel`, and `BudgetHistoryModal` are clean enough to lift component-by-component.

### 10.3 ReportsView — preserve the IRS-line table structure

The Schedule C / Schedule E tables are visually clean and map 1:1 to IRS form lines. The structure is **CFO-specific** (Elyse vs Jeremy split, Whitford House label, year-based tab) but the **layout — top-line SummaryStats, then income table, then expense table, with each line drillable into a transactions drawer — is the right shape for any tax-report surface.** Recreate against the new data shape.

### 10.4 AccountsView — substantially rewrite

Carries the Plaid coexistence (Plaid Link script loader + Patelco/EastRise institution picker) that Report 02 §2.4 and Report 04 §2.4 both flagged as inconsistent. The new system should pick one provider per institution rather than ship a "choose your provider" UI. The visual grouping-by-institution is fine to preserve.

### 10.5 ImportsView — likely retire entirely

Three uploader cards for CSV, Amazon, and Tiller, where Tiller is a one-time migration and Amazon is now handled by the nightly Gmail pipeline (Report 02 §3). Keep CSV import if backfills are still expected; drop the rest.

### 10.6 ConfigView — preserve, simplify

The inline-edit-row pattern in ConfigView is the right primitive for any admin surface in the new system. But the three-table layout (Schedule C / Schedule E / Budget categories) reflects the three-sources-of-truth schema issue called out in Report 02 §5e and Report 04 §2.1 — the new schema should pick one categories model and the Config screen should follow.

### 10.7 IncomeView — preserve the period-navigation pattern

The `← / →` arrow period navigation (annual / quarterly / monthly with offset state) is the cleanest period selector in the app. Lift the `getPeriodBounds` function and the period-nav header into a reusable layout primitive — useful anywhere the new system surfaces time-bound data.

### 10.8 Legacy SPA at `/legacy` — drop entirely

Already a separate `legacy.html` bundle. Report 04 §2.6 recommended dropping it; this audit confirms — there is no visual investment to preserve, and the React SPA at `/` already covers what the user needs.

---

## Closing observations (not asked for, but worth flagging)

- **No design tokens module.** The Tailwind config is the de-facto design tokens file. There's no separate `tokens.json` or `tokens.css` to consume from a non-React project. If the new system has any non-React surface (e.g. an email template or a PDF report), the tokens will need to be duplicated by hand.
- **No Storybook / no component dev environment.** Components are only viewable in the running app.
- **No accessibility audit visible in code.** ARIA usage is sparse: a few `aria-label`s on icon buttons, `role="switch"` and `aria-checked` on the toggle, `<input type="checkbox" ref={el => { if (el) el.indeterminate = ...; }}` on the bulk-selection header. No focus-trap on Drawer / modals (the kit's `Drawer` closes on backdrop click but doesn't restore focus on close).
- **No dark mode.** Deliberate per the Tailwind config comment.
- **Single-user assumption baked in.** Several screens (`AccountsView`, `BudgetView`) assume one user; no profile switcher.
- **The "Sign out" link points at `/logout`.** That route is implemented in the Worker (`src/index.ts:345-356`); SPA does not own auth state.

---

End of report 05.
