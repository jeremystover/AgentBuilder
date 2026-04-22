/**
 * Evidence catalog. Keyed by checklist category; each entry declares which
 * claim types it's relevant to and a short statute hook so the memo and
 * user-facing UI can cite the right authority.
 *
 * This is fact-organizing boilerplate for an employment-law fact pattern in
 * California. It is not legal advice and does not predict claim outcomes;
 * the user should still retain counsel. Statute names are included so the
 * user's attorney can quickly see why each item matters.
 */

import type { ChecklistCategory, ClaimType } from './case-state.js';

export interface CatalogEntry {
  description: string;
  /** Which claim types this item is relevant to. `always` = include regardless of claim type. */
  relevantTo: ClaimType[] | 'always';
  statuteHook?: string;
}

export const CHECKLIST_CATALOG: Record<ChecklistCategory, CatalogEntry[]> = {
  'employment-terms': [
    {
      description: 'Offer letter and signed acceptance',
      relevantTo: 'always',
      statuteHook: 'Establishes role, compensation, and any promised terms.',
    },
    {
      description: 'Employment contract or agreement, if any',
      relevantTo: 'always',
      statuteHook: 'Rebuts at-will presumption (Cal. Lab. Code § 2922).',
    },
    {
      description: 'Employee handbook and any policy updates you received',
      relevantTo: 'always',
      statuteHook: 'Implied-contract and policy-breach analysis; anti-harassment policy compliance.',
    },
    {
      description: 'Arbitration agreement, if signed',
      relevantTo: 'always',
      statuteHook: 'FAA / CA Armendariz factors — affects forum, not merits.',
    },
    {
      description: 'Job description(s) you were hired into and later reassigned to',
      relevantTo: ['wrongful-termination', 'discrimination-feha', 'discrimination-title-vii', 'retaliation'],
    },
  ],
  performance: [
    {
      description: 'All written performance reviews',
      relevantTo: 'always',
      statuteHook: 'Pretext / comparative-performance analysis.',
    },
    {
      description: 'Promotions, bonuses, raises, equity grants, and written recognition',
      relevantTo: 'always',
    },
    {
      description: 'PIPs, written warnings, or coaching plans — including the dates you received them',
      relevantTo: ['wrongful-termination', 'discrimination-feha', 'discrimination-title-vii', 'retaliation', 'whistleblower-1102.5'],
      statuteHook: 'Temporal proximity to protected activity supports inference of retaliation/pretext.',
    },
    {
      description: 'Your own contemporaneous notes or journals about feedback and incidents',
      relevantTo: 'always',
    },
  ],
  comms: [
    {
      description: 'Email chains that relate to you, your performance, or the incident(s)',
      relevantTo: 'always',
    },
    {
      description: 'Slack/Teams/DMs that relate to you, your performance, or the incident(s) — export where permissible',
      relevantTo: 'always',
    },
    {
      description: 'Meeting invites, recordings, and transcripts for any disciplinary or HR meeting',
      relevantTo: 'always',
    },
    {
      description: 'Texts or personal-phone messages from managers or HR',
      relevantTo: 'always',
    },
  ],
  'hr-process': [
    {
      description: 'HR complaints you filed, investigation findings, and all responses',
      relevantTo: ['harassment', 'discrimination-feha', 'discrimination-title-vii', 'retaliation', 'whistleblower-1102.5'],
      statuteHook: 'Shows employer knowledge and response adequacy (Faragher/Ellerth; FEHA reasonable-care duty).',
    },
    {
      description: 'Personnel-file request — California employees may request their personnel file',
      relevantTo: 'always',
      statuteHook: 'Cal. Lab. Code § 1198.5 (access within 30 days).',
    },
    {
      description: 'Payroll-records request — wage statements and time records',
      relevantTo: 'always',
      statuteHook: 'Cal. Lab. Code §§ 226(b), 1174.',
    },
    {
      description: 'Termination letter or written notice, with stated reason',
      relevantTo: 'always',
      statuteHook: 'Compare stated reason to shifting explanations (pretext evidence).',
    },
    {
      description: 'Separation / severance agreement and any attached release',
      relevantTo: 'always',
      statuteHook: 'ADEA / OWBPA 21-day review and 7-day revocation if age 40+.',
    },
  ],
  'protected-activity': [
    {
      description: 'Documentation of any complaint you raised (harassment, discrimination, safety, wage, illegal conduct)',
      relevantTo: ['retaliation', 'whistleblower-1102.5', 'harassment', 'discrimination-feha', 'discrimination-title-vii'],
      statuteHook: 'Title VII § 704, FEHA Gov. Code § 12940(h), Cal. Lab. Code § 1102.5 (whistleblower).',
    },
    {
      description: 'Reasonable-accommodation requests (disability, religion, pregnancy) and the response',
      relevantTo: ['disability-ada-feha', 'discrimination-feha'],
      statuteHook: 'ADA 42 USC § 12112; FEHA Gov. Code § 12940(m); interactive-process duty.',
    },
    {
      description: 'Leave requests (CFRA/FMLA, pregnancy disability, paid sick leave) and approvals/denials',
      relevantTo: ['cfra-fmla-interference'],
      statuteHook: 'CFRA Gov. Code § 12945.2; FMLA 29 USC § 2615; Cal. Lab. Code § 233 (kin care), § 246 (PSL).',
    },
    {
      description: 'Evidence of employer knowledge of your protected activity (who knew, when)',
      relevantTo: ['retaliation', 'whistleblower-1102.5'],
    },
  ],
  comparators: [
    {
      description: 'Names and (if known) performance of similarly-situated coworkers outside your protected class or not engaged in protected activity',
      relevantTo: ['discrimination-feha', 'discrimination-title-vii', 'discrimination-adea', 'disability-ada-feha', 'retaliation'],
      statuteHook: 'Comparator evidence — central to disparate-treatment pretext analysis.',
    },
    {
      description: 'Layoff selection criteria, if you were part of a RIF',
      relevantTo: ['discrimination-adea', 'discrimination-feha', 'warn-cal-warn'],
      statuteHook: 'ADEA disparate-impact; OWBPA group-layoff disclosures (29 USC § 626(f)(1)(H)).',
    },
    {
      description: 'WARN / Cal-WARN notices, if applicable',
      relevantTo: ['warn-cal-warn'],
      statuteHook: 'Fed WARN 29 USC § 2102; Cal-WARN Lab. Code § 1401 (60-day notice for mass layoffs).',
    },
  ],
  financial: [
    {
      description: 'Pay stubs and W-2s covering the last two years',
      relevantTo: 'always',
      statuteHook: 'Damages baseline; wage-statement claims under Cal. Lab. Code § 226.',
    },
    {
      description: 'Bonus/commission plans and any earned-but-unpaid amounts',
      relevantTo: ['wage-hour', 'wrongful-termination'],
      statuteHook: 'Schachter v. Citigroup; Cal. Lab. Code § 204 (timing of wages).',
    },
    {
      description: 'Final-paycheck timing — CA requires immediate payment on involuntary termination',
      relevantTo: 'always',
      statuteHook: 'Cal. Lab. Code § 201 (immediate); § 203 (waiting-time penalties up to 30 days).',
    },
    {
      description: 'Expense reimbursements owed',
      relevantTo: 'always',
      statuteHook: 'Cal. Lab. Code § 2802.',
    },
    {
      description: 'Equity / RSU / option vesting schedules and any unvested amounts forfeited',
      relevantTo: 'always',
    },
  ],
  medical: [
    {
      description: 'Medical records supporting any disability, pregnancy, or workplace-injury claim',
      relevantTo: ['disability-ada-feha', 'cfra-fmla-interference'],
      statuteHook: 'Keep in a separate subfolder — sensitive PHI.',
    },
    {
      description: 'Mental-health or therapy records, if emotional-distress damages are in play',
      relevantTo: 'always',
      statuteHook: 'Privilege considerations — talk to counsel before disclosing.',
    },
    {
      description: 'Doctor notes supporting leave or accommodation requests',
      relevantTo: ['disability-ada-feha', 'cfra-fmla-interference'],
    },
  ],
  witnesses: [
    {
      description: 'List of coworkers with firsthand knowledge — name, role, what they witnessed',
      relevantTo: 'always',
    },
    {
      description: 'Any written statements, emails, or texts from witnesses',
      relevantTo: 'always',
    },
    {
      description: 'Your own contact info for people who have left the company',
      relevantTo: 'always',
    },
  ],
  'exit-artifacts': [
    {
      description: 'Screenshots/exports of your own calendar (events relevant to the case)',
      relevantTo: 'always',
    },
    {
      description: 'Screenshots/exports of your LinkedIn and any public employer content about you',
      relevantTo: 'always',
    },
    {
      description: 'Copy of your org chart or team roster at time of termination',
      relevantTo: ['discrimination-adea', 'discrimination-feha', 'discrimination-title-vii', 'warn-cal-warn'],
    },
    {
      description: 'Company-property receipt / equipment-return acknowledgement',
      relevantTo: 'always',
    },
  ],
};

/**
 * Pull catalog entries that apply given a set of suspected claim types.
 * If no claims are supplied we default to "always" entries so the user
 * still has a starter checklist from the intake alone.
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
