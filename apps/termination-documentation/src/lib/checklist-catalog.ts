/**
 * Evidence catalog, keyed by category. Each entry declares:
 *  - which claim types it's relevant to (CA-first; federal siblings listed where they add remedies),
 *  - the statute / doctrine it supports,
 *  - any default signal flags the item typically carries when collected.
 *
 * This is fact-organizing boilerplate. It is NOT legal advice and does not
 * predict claim outcomes. Statute citations help the user's attorney see
 * why each item matters.
 */

import type { ChecklistCategory, ClaimType, SignalFlag } from './case-state.js';

export interface CatalogEntry {
  description: string;
  /** Which claim types this item is relevant to. `always` = seed regardless of suspected claims. */
  relevantTo: ClaimType[] | 'always';
  statuteHook?: string;
  /** Default signal flags this item carries on collection (the collector can override). */
  defaultSignalFlags?: SignalFlag[];
}

export const CHECKLIST_CATALOG: Record<ChecklistCategory, CatalogEntry[]> = {
  // ── A. Employment terms ────────────────────────────────────────────────────
  'employment-terms': [
    {
      description: 'Offer letter and signed acceptance',
      relevantTo: 'always',
      statuteHook: 'Establishes role, compensation, promised terms.',
    },
    {
      description: 'Employment contract or agreement, if any',
      relevantTo: 'always',
      statuteHook: 'Rebuts at-will presumption (Cal. Lab. Code § 2922).',
    },
    {
      description: 'Employee handbook and any policy updates you received',
      relevantTo: 'always',
      statuteHook: 'Implied-contract analysis; anti-harassment policy compliance (FEHA).',
    },
    {
      description: 'Arbitration agreement, if signed (save with exhibits, all pages)',
      relevantTo: 'always',
      statuteHook: 'FAA / CA Armendariz factors — affects forum, not merits.',
    },
    {
      description: 'Job description(s) at hire and any later reassignment',
      relevantTo: [
        'wrongful-termination-public-policy',
        'age-feha',
        'disability-medical-feha',
        'retaliation-feha',
        'discrimination-title-vii',
      ],
    },
  ],

  // ── B. Performance & praise (HIGHEST SIGNAL) ──────────────────────────────
  performance: [
    {
      description: 'All written performance reviews (ratings, calibrations, summary narratives)',
      relevantTo: 'always',
      statuteHook: 'Pretext / comparative-performance analysis.',
    },
    {
      description: 'Recent written praise from manager, skip-level, or HRBP — preserve exact language and date',
      relevantTo: 'always',
      statuteHook: 'Praise-close-in-time-to-termination undercuts performance pretext.',
      defaultSignalFlags: ['praise-before-termination', 'decisionmaker-communication'],
    },
    {
      description: 'Most recent bonus amount and % of target (bonus plan doc + payout confirmation)',
      relevantTo: 'always',
      statuteHook: 'High recent bonus (e.g., 127% of target) contradicts "performance" explanation.',
      defaultSignalFlags: ['praise-before-termination'],
    },
    {
      description: 'Promotions, raises, equity grants, spot bonuses, and written recognition',
      relevantTo: 'always',
    },
    {
      description: 'Recent successful deliverables — launches, customer wins, metrics hit — in writing',
      relevantTo: 'always',
    },
    {
      description: 'Messages saying you were "on track," "needed," "trusted," or asked to take on new scope',
      relevantTo: 'always',
      defaultSignalFlags: ['praise-before-termination', 'decisionmaker-communication'],
    },
    {
      description: 'Existence (or absence) of a PIP, formal written warning, or progressive-discipline record',
      relevantTo: [
        'age-feha',
        'disability-medical-feha',
        'retaliation-feha',
        'wrongful-termination-public-policy',
        'whistleblower-1102.5',
      ],
      statuteHook: 'Absence of progressive discipline — especially where policy promises it — supports pretext.',
      defaultSignalFlags: ['no-pip-or-progressive-discipline', 'deviation-from-policy'],
    },
    {
      description: 'Your own contemporaneous notes or journals about feedback and incidents',
      relevantTo: 'always',
      statuteHook: 'Contemporaneous notes carry weight when originals are not available.',
    },
  ],

  // ── C. Adverse action & separation ────────────────────────────────────────
  'adverse-action-separation': [
    {
      description: 'Calendar invite for the separation / final conversation (with attendees)',
      relevantTo: 'always',
      statuteHook: 'Fixes decision date and decisionmakers.',
      defaultSignalFlags: ['decisionmaker-communication'],
    },
    {
      description: 'Termination letter or written notice, with the stated reason',
      relevantTo: 'always',
      statuteHook: 'Anchor for comparing to any shifting explanation.',
    },
    {
      description: 'Messages about timing, last day, transition, severance, or garden leave',
      relevantTo: 'always',
      defaultSignalFlags: ['decisionmaker-communication'],
    },
    {
      description: 'Messages asking you to stay and transition / hand off (post-notice)',
      relevantTo: [
        'wrongful-termination-public-policy',
        'age-feha',
        'disability-medical-feha',
        'retaliation-feha',
      ],
      statuteHook: 'Ask-to-stay-and-transition is inconsistent with a real performance-based termination.',
      defaultSignalFlags: ['asked-to-stay-and-transition'],
    },
    {
      description: 'Any change in the stated explanation (performance vs. restructuring vs. fit vs. timing) — capture each version with date and source',
      relevantTo: 'always',
      statuteHook: 'Shifting explanations are classic pretext evidence.',
      defaultSignalFlags: ['shifting-explanation'],
    },
    {
      description: 'Separation / severance agreement and any release attached',
      relevantTo: 'always',
      statuteHook: 'ADEA / OWBPA 21-day review + 7-day revocation (age 40+); CA Civ. Code § 1542.',
    },
    {
      description: 'Offer/proposal of severance terms, including timing of first discussion',
      relevantTo: 'always',
      statuteHook: 'HRBP discussing severance soon after medical disclosure is leverage.',
      defaultSignalFlags: ['employer-knew-of-medical-before-decision'],
    },
  ],

  // ── D. Medical leave / accommodation ──────────────────────────────────────
  'medical-leave-accommodation': [
    {
      description: 'Any message you sent or received mentioning a health issue, further testing, or a doctor recommendation',
      relevantTo: [
        'disability-medical-feha',
        'disability-ada',
        'failure-to-accommodate',
        'failure-interactive-process',
        'cfra-interference',
        'fmla-interference',
        'retaliation-feha',
      ],
      statuteHook: 'FEHA § 12940(a) / ADA knowledge element.',
      defaultSignalFlags: ['employer-knew-of-medical-before-decision'],
    },
    {
      description: 'Leave request or inquiry (CFRA / FMLA / pregnancy / paid sick leave) — with dates and recipient',
      relevantTo: ['cfra-interference', 'fmla-interference', 'failure-to-accommodate', 'retaliation-feha'],
      statuteHook: 'CFRA Gov. Code § 12945.2; FMLA 29 USC § 2615; Cal. Lab. Code § 233 / § 246.',
    },
    {
      description: 'Employer response to a leave or accommodation request (approval, denial, silence)',
      relevantTo: ['failure-to-accommodate', 'failure-interactive-process', 'cfra-interference'],
      statuteHook: 'Gov. Code § 12940(m), (n); Cal. Code Regs. tit. 2 § 11065 et seq.',
    },
    {
      description: 'Doctor note or patient-portal message supporting leave / accommodation (lawfully retained by you)',
      relevantTo: ['disability-medical-feha', 'failure-to-accommodate', 'cfra-interference'],
      statuteHook: 'Store in a separate, access-restricted subfolder — sensitive PHI.',
    },
    {
      description: 'Mental-health or therapy records, if emotional-distress damages are in play',
      relevantTo: 'always',
      statuteHook: 'Privilege implications — discuss with counsel before producing.',
    },
    {
      description: 'Timeline: when did you disclose the medical issue vs. when did the termination decision become final?',
      relevantTo: ['disability-medical-feha', 'failure-to-accommodate', 'cfra-interference', 'retaliation-feha'],
      defaultSignalFlags: ['employer-knew-of-medical-before-decision', 'adverse-close-to-protected-activity'],
    },
  ],

  // ── E. Interactive-process evidence ───────────────────────────────────────
  'interactive-process': [
    {
      description: 'Record of any interactive-process meeting (date, attendees, what was discussed)',
      relevantTo: ['failure-interactive-process', 'failure-to-accommodate', 'disability-medical-feha'],
      statuteHook: 'Gov. Code § 12940(n) — duty to engage in a good-faith interactive process.',
    },
    {
      description: 'Documentation exchanges about accommodation options (yours + employer response)',
      relevantTo: ['failure-interactive-process', 'failure-to-accommodate'],
      statuteHook: 'Interactive process is continuing and collaborative; one-shot denials are a red flag.',
    },
    {
      description: 'Any accommodation the employer offered or refused, with rationale if given',
      relevantTo: ['failure-to-accommodate', 'failure-interactive-process'],
    },
    {
      description: 'Evidence that the employer skipped or shortcut the interactive process (e.g., termination before/instead of accommodation)',
      relevantTo: ['failure-interactive-process', 'failure-to-accommodate', 'disability-medical-feha'],
      defaultSignalFlags: ['deviation-from-policy', 'adverse-close-to-protected-activity'],
    },
  ],

  // ── F. Age-related evidence ───────────────────────────────────────────────
  'age-evidence': [
    {
      description: 'Ageist remark(s) by decisionmakers — date, place, exact words, who was present',
      relevantTo: ['age-feha', 'discrimination-adea', 'wrongful-termination-public-policy'],
      statuteHook: 'Direct-evidence pathway under FEHA / ADEA. Preserve exact language.',
      defaultSignalFlags: ['ageist-remark-from-decisionmaker', 'decisionmaker-communication'],
    },
    {
      description: 'References to "fresh perspective," "energy," "digital native," "new blood," "next generation" in performance / role discussions',
      relevantTo: ['age-feha', 'discrimination-adea'],
      statuteHook: 'Coded ageist language — contextual evidence.',
      defaultSignalFlags: ['ageist-remark-from-decisionmaker'],
    },
    {
      description: 'Demographic pattern: who else at your level was terminated / restructured in the same action, and their approximate ages',
      relevantTo: ['age-feha', 'discrimination-adea', 'warn-cal-warn'],
      statuteHook: 'OWBPA group-layoff disclosures (29 USC § 626(f)(1)(H)); FEHA disparate-impact.',
    },
    {
      description: 'Replacement identity and approximate age (only if lawfully known from personal knowledge)',
      relevantTo: ['age-feha', 'discrimination-adea'],
      statuteHook: 'Replacement-comparator evidence.',
    },
  ],

  // ── G. Comms ──────────────────────────────────────────────────────────────
  comms: [
    {
      description: 'Email chains that relate to you, your performance, or the incident(s) — preserve full headers and thread',
      relevantTo: 'always',
      statuteHook: 'Preserve originals; don\'t strip metadata.',
    },
    {
      description: 'Slack/Teams/DMs that relate to you — export where permissible; screenshots with timestamp otherwise',
      relevantTo: 'always',
    },
    {
      description: 'Meeting invites, recordings, and transcripts for any disciplinary, HR, or separation meeting',
      relevantTo: 'always',
      statuteHook: 'Do NOT secretly record — CA Penal Code § 632 requires all-party consent.',
    },
    {
      description: 'Texts or personal-phone messages from managers or HR',
      relevantTo: 'always',
    },
  ],

  // ── HR process ────────────────────────────────────────────────────────────
  'hr-process': [
    {
      description: 'HR complaints you filed, investigation findings, and all responses',
      relevantTo: [
        'retaliation-feha',
        'harassment-feha',
        'disability-medical-feha',
        'age-feha',
        'whistleblower-1102.5',
      ],
      statuteHook: 'Employer knowledge + response adequacy (Faragher/Ellerth; FEHA reasonable-care duty).',
    },
    {
      description: 'Personnel-file request under Cal. Lab. Code § 1198.5',
      relevantTo: 'always',
      statuteHook: 'CA employees may request their personnel file; employer must produce within 30 days.',
    },
    {
      description: 'Payroll-records request under Cal. Lab. Code § 226(b)',
      relevantTo: 'always',
      statuteHook: 'Wage statements and time records — 21-day production window.',
    },
    {
      description: 'Handbook sections on performance management, progressive discipline, leave, accommodation, severance',
      relevantTo: 'always',
      statuteHook: 'Deviation from stated policy supports pretext.',
      defaultSignalFlags: ['deviation-from-policy'],
    },
    {
      description: 'Any documented deviation from the employer\'s usual practice in your case',
      relevantTo: 'always',
      defaultSignalFlags: ['deviation-from-policy'],
    },
  ],

  // ── Protected activity (complaints, whistleblowing) ───────────────────────
  'protected-activity': [
    {
      description: 'Any complaint you raised (harassment, discrimination, safety, wage, illegal conduct) — date, recipient, content',
      relevantTo: [
        'retaliation-feha',
        'whistleblower-1102.5',
        'harassment-feha',
        'wrongful-termination-public-policy',
      ],
      statuteHook: 'FEHA § 12940(h); Cal. Lab. Code § 1102.5; Tameny.',
    },
    {
      description: 'Evidence of employer knowledge of your protected activity (who knew, when, how)',
      relevantTo: ['retaliation-feha', 'whistleblower-1102.5'],
      defaultSignalFlags: ['adverse-close-to-protected-activity'],
    },
    {
      description: 'Timeline of protected activity vs. adverse action — close temporal proximity supports inference',
      relevantTo: ['retaliation-feha', 'whistleblower-1102.5', 'cfra-interference'],
      defaultSignalFlags: ['adverse-close-to-protected-activity'],
    },
  ],

  // ── Comparators / replacement ─────────────────────────────────────────────
  comparators: [
    {
      description: 'Names and (if lawfully known) performance of similarly-situated coworkers outside your protected class / not engaged in protected activity',
      relevantTo: [
        'age-feha',
        'disability-medical-feha',
        'retaliation-feha',
        'discrimination-title-vii',
        'discrimination-adea',
      ],
      statuteHook: 'Comparator evidence — central to disparate-treatment pretext.',
    },
    {
      description: 'Layoff selection criteria, if you were part of a RIF (obtain only if lawful for you to possess)',
      relevantTo: ['age-feha', 'discrimination-adea', 'warn-cal-warn'],
      statuteHook: 'OWBPA group-layoff disclosures.',
    },
    {
      description: 'WARN / Cal-WARN notices, if applicable',
      relevantTo: ['warn-cal-warn'],
      statuteHook: 'Fed WARN 29 USC § 2102; Cal-WARN Lab. Code § 1401 (60-day notice).',
    },
  ],

  // ── Financial / damages ───────────────────────────────────────────────────
  financial: [
    {
      description: 'Pay stubs and W-2s for the last two years',
      relevantTo: 'always',
      statuteHook: 'Damages baseline; wage-statement claims under Cal. Lab. Code § 226.',
    },
    {
      description: 'Offer letter comp summary and subsequent comp changes',
      relevantTo: 'always',
    },
    {
      description: 'Bonus plan document + payout history (including the 127%-type recent payout if applicable)',
      relevantTo: ['wage-hour', 'wrongful-termination-public-policy'],
      statuteHook: 'Schachter v. Citigroup; Cal. Lab. Code § 204.',
      defaultSignalFlags: ['praise-before-termination'],
    },
    {
      description: 'Final-paycheck timing — CA requires immediate payment on involuntary termination',
      relevantTo: 'always',
      statuteHook: 'Cal. Lab. Code § 201 (immediate); § 203 (waiting-time penalties up to 30 days).',
    },
    {
      description: 'PTO accrual and payout at separation',
      relevantTo: 'always',
      statuteHook: 'Cal. Lab. Code § 227.3 — accrued vacation is wages, must be paid out.',
    },
    {
      description: 'Expense reimbursements owed',
      relevantTo: 'always',
      statuteHook: 'Cal. Lab. Code § 2802.',
    },
    {
      description: 'Equity grants — RSUs / options / PSUs — grant agreements and vesting schedules',
      relevantTo: 'always',
    },
    {
      description: 'Post-termination option exercise window terms (e.g., 90 days from separation)',
      relevantTo: 'always',
      statuteHook: 'Often the largest economic lever in severance negotiations for execs.',
      defaultSignalFlags: ['damages-equity-exercise-window'],
    },
    {
      description: 'Unvested equity forfeited on separation — estimated dollar value',
      relevantTo: 'always',
      defaultSignalFlags: ['damages-equity-exercise-window'],
    },
    {
      description: 'Acceleration clauses (single-trigger, double-trigger, change-of-control)',
      relevantTo: 'always',
    },
    {
      description: 'Deferred comp, ESPP, and any other compensation plan terms',
      relevantTo: 'always',
    },
    {
      description: 'COBRA notice and election-timing information',
      relevantTo: 'always',
      statuteHook: '29 USC § 1166; 60-day election window from later of termination or notice.',
    },
  ],

  // ── Witnesses ─────────────────────────────────────────────────────────────
  witnesses: [
    {
      description: 'List of coworkers with firsthand knowledge — name, role, what they witnessed',
      relevantTo: 'always',
    },
    {
      description: 'Written statements, emails, or texts from witnesses (no coerced statements)',
      relevantTo: 'always',
    },
    {
      description: 'Personal contact info for people who have left the company',
      relevantTo: 'always',
    },
  ],

  // ── Exit artifacts ────────────────────────────────────────────────────────
  'exit-artifacts': [
    {
      description: 'Screenshots/exports of your own calendar (events relevant to the case) — preserve metadata',
      relevantTo: 'always',
    },
    {
      description: 'Screenshots/exports of your LinkedIn and any public employer content about you',
      relevantTo: 'always',
    },
    {
      description: 'Copy of your org chart or team roster at time of termination (only if lawfully in your possession)',
      relevantTo: ['age-feha', 'discrimination-adea', 'warn-cal-warn'],
    },
    {
      description: 'Company-property receipt / equipment-return acknowledgement',
      relevantTo: 'always',
    },
  ],
};

/**
 * Pull catalog entries that apply given a set of suspected claim types.
 * If no claims are supplied we include "always" entries so the user still
 * has a starter checklist from the intake alone.
 */
export function catalogFor(claims: ClaimType[]): Array<{
  category: ChecklistCategory;
  entry: CatalogEntry;
}> {
  const claimSet = new Set(claims);
  const out: Array<{ category: ChecklistCategory; entry: CatalogEntry }> = [];
  for (const category of Object.keys(CHECKLIST_CATALOG) as ChecklistCategory[]) {
    for (const entry of CHECKLIST_CATALOG[category]) {
      const include =
        entry.relevantTo === 'always' ||
        entry.relevantTo.some((c) => claimSet.has(c)) ||
        claimSet.size === 0;
      if (include) out.push({ category, entry });
    }
  }
  return out;
}
