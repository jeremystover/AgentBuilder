# Termination Documentation

**Purpose.** Guides a California employee who has been (or is about to be)
terminated through documenting a possible wrongful-termination, retaliation,
discrimination, harassment, or wage-and-hour claim. The agent interviews the
user, builds a tailored evidence-collection plan grounded in US federal and
California employment law, tracks collection progress, ingests files uploaded
through Claude.ai into an organized Google Drive case folder, maintains a
Google Docs evidence memo suitable for sharing with legal counsel or HR during
severance negotiation, and walks through a 24-hour company-exit playbook
assuming the user will only have their work computer for a short window.

> **Not legal advice.** This agent helps organize facts and documents. It does
> not represent the user, does not assess the merits of a claim, and does not
> replace a licensed California employment attorney. Surface that reminder on
> the first turn of every session and before emitting the evidence memo.

## When to call me
- "I think I'm about to be laid off / fired in California — help me document it"
- "Build me a wrongful-termination evidence checklist"
- "I was fired after reporting [harassment / wage theft / safety issue] — what do I collect?"
- "Interview me about my situation so we can plan what to document"
- "I'm uploading my offer letter, performance reviews, and Slack exports — file them"
- "Draft an evidence memo I can share with my employment lawyer"
- "I have 24 hours with my work laptop — walk me through what to grab"
- "Organize my termination case in Google Drive"
- "What's still missing from my evidence packet?"

## Non-goals
- **Giving legal advice or assessing the strength of a claim.** The agent
  names relevant statutes (Title VII, ADA, ADEA, FEHA, CFRA, Cal. Labor Code
  §§ 1102.5 / 232.5 / 233, WARN / Cal-WARN, etc.) only so the user and their
  counsel know which facts matter. It does not predict outcomes.
- **Representing the user.** Not a lawyer, not a paralegal. Explicitly not a
  substitute for an employment attorney, a DFEH/CRD intake, or an EEOC filing.
- **Filing charges or sending demand letters** on the user's behalf.
- **Negotiating severance or drafting settlement demands.** The memo is a
  factual record the user hands to counsel; the agent does not negotiate.
- **Advising the user to remove employer-confidential or trade-secret
  material.** The agent helps preserve *the user's own* evidence — their
  performance reviews, comms that relate to them personally, their pay
  records, their own drafts — and explicitly steers away from proprietary
  customer lists, source code, or competitively sensitive documents. When
  in doubt, it tells the user to photograph or note the existence of a
  document rather than exfiltrate it.
- **Contacting witnesses, coworkers, HR, or employer counsel** on behalf of
  the user.
- **Personal productivity, calendar, or task management** (that's
  Chief of Staff).
- **Tax / 401(k) rollover / severance-financial modeling** (that's CFO).
- **Persistent article ingestion or research-corpus search** (that's
  Research Agent).
- **Building or modifying other agents** (that's Agent Builder).
- **Jurisdictions other than California / US federal law.** If the user
  says they worked in another state, the agent flags that the CA-specific
  guidance may not apply and recommends local counsel.

## Tools (MCP surface — POST /mcp)

Nine tools, under the fleet cap. Each updates state in the Durable Object so
the user can pause and resume across sessions.

| Tool | Description |
|---|---|
| `intake_interview` | Records case profile facts (employer, role, age, dates, jurisdiction, protected class / activity, narrative, suspected claims) plus the high-value signals (recent praise, bonus %, last rating, PIP status, ask-to-stay-and-transition, employer knowledge of medical issue before decision, shifting stated reasons, ageist remarks, equity exercise window, unvested equity value). Returns remaining intake questions and `suggested_claim_additions` derived from the answers (age ≥ 40 + adverse → age-feha + ADEA; medical-knowledge-before-decision → disability-medical-feha + failure-to-accommodate + interactive-process; leave protected activity → cfra-interference; any protected activity + adverse → retaliation-feha; statute-based trigger + adverse → Tameny). |
| `build_evidence_plan` | Seeds the evidence checklist from a CA + federal catalog (13 categories including adverse-action-separation, medical-leave-accommodation, interactive-process, age-evidence) keyed to the suspected claim types. Catalog items carry default signal flags on collection. When `create_drive_folder=true` and `user_id` is provided, creates the Google Drive case folder and category subfolders. |
| `update_checklist` | Add a custom item, edit, or change status (pending / have / collected / unavailable / skipped / restore). On collection, captures the evidence-index metadata: `file_name`, `source_type`, `date_created`, `date_event`, `author { name, role, is_decisionmaker }`, `recipients`, `exact_quotes`, `why_it_matters`, `claim_tags`, 1–5 scores (`relevance`, `reliability`, `timing_proximity`, `confidentiality_risk`), `preserve_original`, `authenticity_notes`, `signal_flags`. |
| `chronology` | Manage the master chronology: `add` / `list` / `update` / `delete`. Each event has id, date, actors, event description, exact quote, supporting checklist item ids, why it matters, claim tags, signal flags. |
| `ingest_upload` | Ingests a base64-encoded file from Claude.ai, files it into the right Drive subfolder, and marks the matching checklist item collected with full metadata. Requires `lawful_to_possess_confirmation=true` so the user affirms the file is theirs, not privileged, not an investigation record, not another employee's data, and not trade-secret material. Degrades to local-only (checklist entry saved, no Drive) if Google isn't configured. |
| `generate_top_packet` | Returns the top-N most persuasive exhibits ranked by a transparent composite score: relevance × 3 + reliability × 2 + timing_proximity × 2 − confidentiality_risk, +2 per signal flag, +2 decisionmaker author, +1 preserved original, +1 exact quotes captured. Filterable by claim. |
| `gap_report` | Enumerates missing high-value facts (final decision date, PIP status, ask-to-stay, medical knowledge timing, shifting reasons, ageist remarks log, equity exercise window, arbitration status, replacement identity, interactive-process record, personnel-file/payroll requests, COBRA, final paycheck). Each gap carries priority, blocking claims, and suggested sources. Reports a `coverage_score` percent. |
| `draft_memo` | Renders a markdown memo. Two variants: `negotiation` (1–2 pg factual leverage summary for HR / severance counter-proposal) or `counsel` (full evidence file with chronology + top-N + gap report for attorney review). Facts-only, no legal conclusions; every claim gets labeled Gov. Code / USC citations; includes the not-legal-advice disclaimer. When `write_to_docs=true` and `user_id` is provided, also writes the memo to Google Docs and tracks the doc id in state. |
| `status` | Case profile, checklist summary (by status / category / signal flag), prioritized `next_up` (weighted by signal-flag presence), top-scored collected items, Drive folder URL, memo doc URL, and exit-playbook progress. |

## State model (Durable Object)

One `TerminationDocumentationDO` instance per user / case. Stores:

- `case_profile` — facts gathered in intake.
- `checklist` — array of evidence items `{ id, category, description, statute_hook, status, location_hint, drive_file_id, notes }`.
- `drive` — `{ root_folder_id, subfolder_ids }` for the case folder.
- `memo` — `{ doc_id, last_updated_at }`.
- `exit_tasks` — array of `{ id, description, rationale, status }` for the 24-hour exit.

All writes go through the tools above; no direct state mutation from the
model.

## Shared packages
- `@agentbuilder/core`
- `@agentbuilder/llm`
- `@agentbuilder/auth-google` — Drive + Docs OAuth via the shared token vault
  (one client reused across the fleet, per repo rule 5).

## OAuth scopes
- `https://www.googleapis.com/auth/drive` — create the case folder, upload
  files, organize subfolders, share with the user's attorney.
- `https://www.googleapis.com/auth/documents` — create and update the
  evidence memo.

Both are reused from the shared `@agentbuilder/auth-google` client — the
agent never imports `google-auth-library` directly.

## Interview + collection flow

1. **Disclaimer + intake.** Agent opens with the not-legal-advice reminder
   and asks the user for consent to proceed. Then runs `intake_interview`
   to build the case profile (a few questions at a time, not a wall of
   25).
2. **Plan.** `build_evidence_plan` produces the tailored checklist and
   creates the Drive case folder. Agent summarizes the plan in chat with
   a rationale per category.
3. **Inventory.** `inventory_interview` walks the list item-by-item,
   marking what the user already has, what's on the work laptop (time-boxed
   to the 24-hour exit window), and what will need to be re-requested
   (e.g., personnel file under Cal. Labor Code § 1198.5, payroll records
   under § 226(b)).
4. **Collect.** As the user uploads files via Claude.ai, `ingest_upload`
   classifies and files each one. `update_checklist` keeps the open-items
   list accurate. The agent nudges toward the next highest-value item
   ("comparator performance data is still missing — can you think of a
   peer with similar reviews who wasn't terminated?").
5. **Memo.** `draft_evidence_memo` is re-run as material accumulates. The
   agent shows the Doc link, asks the user to review, and flags open
   questions for counsel.
6. **Exit.** `exit_playbook` runs in parallel if the user still has laptop
   access. Every task either points at the user's own data or at
   personal-email / personal-phone actions — no exfiltration of
   employer-confidential material.

## Notes
- Model tier: `default` (Sonnet) for interview, memo drafting, and
  classification. Drop to `fast` (Haiku) for checklist-tick classification
  of short uploads.
- Prompt caching: on by default via `@agentbuilder/llm`. The disclaimer,
  statute-hook reference table, and evidence-category taxonomy are all
  stable and should stay in the cached system prompt.
- Privacy: this case folder contains sensitive material, including
  potentially protected health information if disability or CFRA is in
  play. The Drive folder is created in the user's own Drive, not a shared
  agent account. The agent never copies files into its own storage; it
  references Drive file ids.
- All dates, names, and numbers stay as the user provided them. The memo
  never invents facts or characterizations; any inference is labeled
  "open question for counsel."
