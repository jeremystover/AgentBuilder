import type {
  CaseProfile,
  CaseState,
  ChecklistItem,
  ChronologyEvent,
  ClaimType,
} from '../../lib/case-state.js';
import { generateTopPacket } from './generate_top_packet.js';
import { gapReport } from './gap_report.js';

export type MemoType = 'negotiation' | 'counsel';

export interface DraftMemoInput {
  type: MemoType;
  /** Top-N exhibits to enumerate. Default 20. */
  include_top_n?: number;
  /** Include the master chronology section. Default true for counsel, false for negotiation. */
  include_chronology?: boolean;
  /** Include the gap report. Default false for negotiation, true for counsel. */
  include_gap_report?: boolean;
}

export interface DraftMemoOutput {
  markdown: string;
  word_count: number;
  sections_included: string[];
  notes_to_user: string[];
}

const DISCLAIMER =
  '**This memo is a factual compilation, not legal advice.** It was assembled by an AI assistant to organize evidence for review by licensed California employment counsel. No attorney–client relationship is created by this document. The user remains responsible for verifying every fact before relying on it.';

const CLAIM_LABELS: Record<ClaimType, string> = {
  'age-feha': 'Age discrimination — Cal. Gov. Code § 12940(a) (FEHA)',
  'disability-medical-feha':
    'Disability / medical-condition discrimination — Cal. Gov. Code § 12940(a) (FEHA)',
  'failure-to-accommodate': 'Failure to provide reasonable accommodation — Cal. Gov. Code § 12940(m)',
  'failure-interactive-process':
    'Failure to engage in the interactive process — Cal. Gov. Code § 12940(n)',
  'retaliation-feha': 'Retaliation — Cal. Gov. Code § 12940(h) (FEHA)',
  'harassment-feha': 'Harassment — Cal. Gov. Code § 12940(j) (FEHA)',
  'cfra-interference': 'CFRA interference / retaliation — Cal. Gov. Code § 12945.2',
  'wrongful-termination-public-policy': 'Wrongful termination in violation of public policy (Tameny)',
  'whistleblower-1102.5': 'Whistleblower retaliation — Cal. Lab. Code § 1102.5',
  'wage-hour': 'Wage-and-hour — Cal. Lab. Code §§ 201, 203, 226, 227.3, 2802',
  'warn-cal-warn': 'WARN / Cal-WARN — 29 U.S.C. § 2102; Cal. Lab. Code § 1401',
  'discrimination-title-vii': 'Title VII discrimination — 42 U.S.C. § 2000e',
  'discrimination-adea': 'Age discrimination — ADEA, 29 U.S.C. § 623',
  'disability-ada': 'Disability discrimination — ADA, 42 U.S.C. § 12112',
  'fmla-interference': 'FMLA interference / retaliation — 29 U.S.C. § 2615',
  other: 'Other (specify with counsel)',
};

export function draftMemo(state: CaseState, input: DraftMemoInput): DraftMemoOutput {
  const type = input.type;
  const includeChronology = input.include_chronology ?? type === 'counsel';
  const includeGaps = input.include_gap_report ?? type === 'counsel';
  const topN = input.include_top_n ?? 20;

  const sections: string[] = [];
  const parts: string[] = [];

  parts.push(headerSection(state.profile, type));
  sections.push('header');

  parts.push(disclaimerSection());
  sections.push('disclaimer');

  parts.push(claimsSection(state.profile));
  sections.push('claim_buckets');

  parts.push(keySignalsSection(state));
  sections.push('key_signals');

  parts.push(damagesSection(state.profile));
  sections.push('damages');

  if (includeChronology && state.chronology.length > 0) {
    parts.push(chronologySection(state.chronology, state.checklist));
    sections.push('chronology');
  }

  const topPacket = generateTopPacket(state, { top_n: topN });
  if (topPacket.packet.length > 0) {
    parts.push(topPacketSection(topPacket.packet, type));
    sections.push('top_packet');
  }

  if (includeGaps) {
    const gaps = gapReport(state, {});
    parts.push(gapsSection(gaps));
    sections.push('gap_report');
  }

  parts.push(openQuestionsSection(state, type));
  sections.push('open_questions');

  const markdown = parts.join('\n\n').trim() + '\n';
  const wordCount = markdown.split(/\s+/).filter(Boolean).length;

  const notes: string[] = [];
  if (type === 'negotiation' && topPacket.packet.length === 0) {
    notes.push(
      'Negotiation memo is thin — no scored exhibits. Tag your strongest documents via update_checklist with relevance / reliability / timing_proximity scores and signal flags, then rerun.',
    );
  }
  if (type === 'counsel' && state.chronology.length === 0) {
    notes.push(
      'Counsel packet is missing the master chronology. Add events via chronology(action=add) for the key moments (hire, reviews, protected activity, medical disclosure, decision date, termination).',
    );
  }
  if (state.profile.jurisdiction !== 'CA') {
    notes.push(
      'Profile jurisdiction is not California — CA-specific statute citations may not apply. Consult local counsel.',
    );
  }
  notes.push(
    'Before sharing this memo: verify every date, quote, and name; confirm no privileged material was inadvertently included; preserve originals separately.',
  );

  return {
    markdown,
    word_count: wordCount,
    sections_included: sections,
    notes_to_user: notes,
  };
}

// ── Sections ────────────────────────────────────────────────────────────────

function headerSection(profile: CaseProfile, type: MemoType): string {
  const title =
    type === 'negotiation'
      ? 'Negotiation Leverage Memo — Factual Summary'
      : 'Counsel Packet — Evidence File for Attorney Review';
  const lines: string[] = [`# ${title}`, ''];
  const e = profile.employer;
  const emp = profile.employee;
  lines.push(`- **Employer:** ${e.name ?? '(unspecified)'}`);
  if (e.hqState) lines.push(`- **HQ state / worksite:** ${e.hqState}`);
  if (emp.role) lines.push(`- **Role:** ${emp.role}`);
  const dates = [emp.startDate, emp.endDate].filter(Boolean).join(' → ');
  if (dates) lines.push(`- **Dates:** ${dates}`);
  if (emp.age !== undefined) lines.push(`- **Age at termination:** ${emp.age}`);
  lines.push(`- **Jurisdiction:** ${profile.jurisdiction}`);
  if (emp.hasArbitrationAgreement !== undefined)
    lines.push(`- **Arbitration agreement:** ${emp.hasArbitrationAgreement ? 'yes' : 'no'}`);
  return lines.join('\n');
}

function disclaimerSection(): string {
  return `> ${DISCLAIMER}`;
}

function claimsSection(profile: CaseProfile): string {
  const lines = ['## Claim buckets under consideration', ''];
  if (profile.suspectedClaims.length === 0) {
    lines.push('*(None recorded yet — run intake_interview.)*');
    return lines.join('\n');
  }
  for (const c of profile.suspectedClaims) {
    lines.push(`- ${CLAIM_LABELS[c] ?? c}`);
  }
  return lines.join('\n');
}

function keySignalsSection(state: CaseState): string {
  const { profile } = state;
  const s = profile.signals;
  const lines = ['## Key factual signals', ''];

  // Praise before termination
  if ((s.recentPraiseExamples?.length ?? 0) > 0 || s.recentBonusPercent || s.lastReviewRating) {
    lines.push('### Praise / performance close in time to termination');
    if (s.lastReviewRating) lines.push(`- Last performance rating: **${s.lastReviewRating}**`);
    if (s.recentBonusPercent)
      lines.push(`- Most recent bonus: **${s.recentBonusPercent}% of target**`);
    for (const p of s.recentPraiseExamples ?? []) lines.push(`- Recent praise: ${p}`);
    lines.push('');
  }

  // PIP
  if (s.hadPipOrProgressiveDiscipline === false) {
    lines.push('### Absence of PIP / progressive discipline');
    lines.push(
      '- No PIP or formal written warning preceded the termination.' +
        (s.pipNarrative ? ` ${s.pipNarrative}` : ''),
    );
    lines.push('');
  } else if (s.hadPipOrProgressiveDiscipline === true && s.pipNarrative) {
    lines.push('### PIP / progressive discipline');
    lines.push(`- ${s.pipNarrative}`);
    lines.push('');
  }

  // Ask to stay
  if (s.askedToStayAndTransition === true) {
    lines.push('### Ask to stay and transition post-notice');
    lines.push(
      '- After being told employment was ending, the employee was asked to stay and transition.' +
        (s.askedToStayNarrative ? ` ${s.askedToStayNarrative}` : ''),
    );
    lines.push('');
  }

  // Medical knowledge
  if (s.employerKnewOfMedicalBeforeDecision === true) {
    lines.push('### Employer knowledge of medical issue before decision was final');
    lines.push(
      '- Employer was on notice of a medical issue / possible leave before the termination decision was final.' +
        (s.medicalKnowledgeNarrative ? ` ${s.medicalKnowledgeNarrative}` : ''),
    );
    lines.push('');
  }

  // Shifting reasons
  if ((s.statedReasonsTimeline?.length ?? 0) >= 2) {
    lines.push('### Shifting stated reasons');
    for (const r of s.statedReasonsTimeline ?? []) {
      const bits = [r.date, r.source, r.reason].filter(Boolean);
      lines.push(`- ${bits.join(' — ')}`);
    }
    lines.push('');
  }

  // Ageist remarks
  if ((s.ageistRemarks?.length ?? 0) > 0) {
    lines.push('### Ageist remarks by decisionmakers');
    for (const r of s.ageistRemarks ?? []) {
      const bits: string[] = [];
      if (r.date) bits.push(r.date);
      if (r.place) bits.push(r.place);
      if (r.remarker) bits.push(`*${r.remarker}*`);
      if (r.exactWords) bits.push(`"${r.exactWords}"`);
      if (r.witnesses?.length) bits.push(`(witnesses: ${r.witnesses.join(', ')})`);
      lines.push(`- ${bits.join(' — ')}`);
    }
    lines.push('');
  }

  // Protected activity
  if (profile.protectedActivity.length > 0) {
    lines.push('### Protected activity');
    for (const a of profile.protectedActivity) lines.push(`- ${a}`);
    lines.push('');
  }

  if (lines.length === 2) {
    lines.push('*(No signals captured yet — run intake_interview with the high-value fields.)*');
  }

  return lines.join('\n').trimEnd();
}

function damagesSection(profile: CaseProfile): string {
  const s = profile.signals;
  const lines = ['## Damages / economic leverage', ''];
  if (s.equityExerciseWindow) lines.push(`- **Option exercise window:** ${s.equityExerciseWindow}`);
  if (s.unvestedEquityValue !== undefined)
    lines.push(`- **Unvested equity at risk:** $${s.unvestedEquityValue.toLocaleString()}`);
  if (s.recentBonusPercent)
    lines.push(`- **Prior-year bonus:** ${s.recentBonusPercent}% of target (contradicts performance narrative).`);
  lines.push(
    '- Final-paycheck timing — Cal. Lab. Code § 201 (immediate on involuntary termination); § 203 waiting-time penalties up to 30 days.',
  );
  lines.push('- Accrued PTO payout — Cal. Lab. Code § 227.3.');
  lines.push('- Expense reimbursements owed — Cal. Lab. Code § 2802.');
  lines.push('- COBRA election window — 60 days from later of termination / notice.');
  return lines.join('\n');
}

function chronologySection(events: ChronologyEvent[], checklist: ChecklistItem[]): string {
  const itemById = new Map(checklist.map((i) => [i.id, i]));
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const lines = ['## Master chronology', ''];
  for (const e of sorted) {
    const actors = e.actors.length ? ` — *${e.actors.join(', ')}*` : '';
    lines.push(`### ${e.date}${actors}`);
    lines.push(`- **Event:** ${e.event}`);
    if (e.exactQuote) lines.push(`- **Exact quote:** "${e.exactQuote}"`);
    if (e.whyItMatters) lines.push(`- **Why it matters:** ${e.whyItMatters}`);
    if (e.supportingItemIds.length > 0) {
      const refs = e.supportingItemIds
        .map((id) => itemById.get(id)?.description ?? id)
        .map((d) => `"${truncate(d, 60)}"`);
      lines.push(`- **Supporting exhibits:** ${refs.join('; ')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function topPacketSection(
  packet: ReturnType<typeof generateTopPacket>['packet'],
  type: MemoType,
): string {
  const heading =
    type === 'negotiation' ? `## Leverage exhibits (top ${packet.length})` : `## Evidence index — top ${packet.length} exhibits by score`;
  const lines = [heading, ''];
  for (const p of packet) {
    lines.push(`### ${p.rank}. ${p.description}`);
    const meta: string[] = [];
    if (p.date_event) meta.push(`date: ${p.date_event}`);
    if (p.source_type) meta.push(`source: ${p.source_type}`);
    if (p.author?.name) {
      const role = p.author.role ? ` (${p.author.role})` : '';
      const dm = p.author.isDecisionmaker ? ' — decisionmaker' : '';
      meta.push(`author: ${p.author.name}${role}${dm}`);
    }
    meta.push(`score: ${p.composite_score}`);
    if (p.signal_flags?.length) meta.push(`signals: ${p.signal_flags.join(', ')}`);
    lines.push(`- ${meta.join(' · ')}`);
    if (p.exact_quotes?.length) {
      for (const q of p.exact_quotes) lines.push(`- Quote: "${q}"`);
    }
    if (p.why_it_matters) lines.push(`- Why it matters: ${p.why_it_matters}`);
    if (p.claim_tags?.length)
      lines.push(`- Relevant to: ${p.claim_tags.map((c) => CLAIM_LABELS[c] ?? c).join('; ')}`);
    if (p.drive_file_id) lines.push(`- Drive file: ${p.drive_file_id}`);
    if (p.file_name) lines.push(`- File: ${p.file_name}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function gapsSection(report: ReturnType<typeof gapReport>): string {
  const lines = ['## Factual gaps', ''];
  if (report.gaps.length === 0) {
    lines.push('*No gaps detected against the current rule set.*');
    return lines.join('\n');
  }
  lines.push(
    `Coverage score: **${report.summary.coverage_score}%**. ${report.summary.high_priority} high-priority, ${report.summary.medium_priority} medium, ${report.summary.low_priority} low.`,
  );
  lines.push('');
  for (const g of report.gaps) {
    lines.push(`### [P${g.priority}] ${g.title}`);
    lines.push(`- **Why needed:** ${g.why_needed}`);
    if (g.blocking_claims?.length)
      lines.push(`- **Blocks:** ${g.blocking_claims.map((c) => CLAIM_LABELS[c] ?? c).join('; ')}`);
    if (g.suggested_sources?.length) {
      lines.push('- **Suggested sources:**');
      for (const src of g.suggested_sources) lines.push(`  - ${src}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function openQuestionsSection(state: CaseState, type: MemoType): string {
  const { profile } = state;
  const lines = ['## Open questions for counsel', ''];
  if (type === 'negotiation') {
    lines.push(
      '- What is the realistic range for a severance uplift given the exercise-window lever and the temporal-proximity signals?',
    );
    lines.push(
      '- Is the arbitration agreement likely enforceable under Armendariz / EFAA?',
    );
    lines.push(
      '- Should the negotiation demand include extending the option exercise window vs. pure cash?',
    );
  } else {
    lines.push('- Pretext strategy — which signal cluster is strongest to lead with?');
    lines.push('- Exhaustion: DFEH/CRD filing plan and timing; EEOC dual filing.');
    lines.push('- Forum: arbitration enforceability and severability analysis.');
    lines.push(
      '- Whether to add common-law Tameny claim alongside statutory FEHA claims for distinct remedies.',
    );
  }
  if (profile.employee.age !== undefined && profile.employee.age < 40) {
    lines.push('- Age is under 40 — confirm age-protected analysis is truly in play.');
  }
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
