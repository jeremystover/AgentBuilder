import type { CaseState, ChecklistItem, ClaimType } from '../../lib/case-state.js';

export interface GapReportInput {
  /** If true, include gaps that don't currently block any suspected claim. Default false. */
  include_low_priority?: boolean;
}

export interface Gap {
  id: string;
  priority: 1 | 2 | 3;
  title: string;
  why_needed: string;
  blocking_claims?: ClaimType[];
  suggested_sources?: string[];
}

export interface GapReportOutput {
  gaps: Gap[];
  summary: {
    total: number;
    high_priority: number;
    medium_priority: number;
    low_priority: number;
    coverage_score: number; // 0-100, higher = fewer critical gaps
  };
  notes_to_user: string[];
}

type GapRule = {
  id: string;
  priority: 1 | 2 | 3;
  title: string;
  whyNeeded: string;
  blockingClaims?: ClaimType[];
  suggestedSources?: string[];
  /** True when the gap is present (fact is missing). */
  check: (state: CaseState) => boolean;
};

const GAP_RULES: GapRule[] = [
  {
    id: 'final-decision-date',
    priority: 1,
    title: 'When did the termination decision become final?',
    whyNeeded:
      'Anchors the "employer-knew-of-medical-before-decision" analysis and temporal-proximity arguments under FEHA §§ 12940(a)/(h) and CFRA § 12945.2.',
    blockingClaims: [
      'disability-medical-feha',
      'failure-to-accommodate',
      'failure-interactive-process',
      'retaliation-feha',
      'cfra-interference',
    ],
    suggestedSources: [
      'Calendar invite for internal decision meeting (CPO + legal + HRBP)',
      'First severance-proposal email timestamp',
      'Slack / email between manager and HRBP saying "we\'ve decided"',
    ],
    check: (s) => !s.profile.employee.endDate,
  },
  {
    id: 'pip-status-unknown',
    priority: 1,
    title: 'Was there a PIP or formal progressive-discipline process?',
    whyNeeded:
      'Absence of PIP where the handbook promises progressive discipline is classic pretext evidence.',
    blockingClaims: [
      'age-feha',
      'disability-medical-feha',
      'retaliation-feha',
      'wrongful-termination-public-policy',
    ],
    suggestedSources: [
      'Your own answer — yes/no with date if yes',
      'Handbook section on progressive discipline (compare to your case)',
    ],
    check: (s) => s.profile.signals.hadPipOrProgressiveDiscipline === undefined,
  },
  {
    id: 'ask-to-stay-unknown',
    priority: 1,
    title: 'Were you asked to stay and transition post-notice?',
    whyNeeded:
      'Ask-to-stay-and-transition is inconsistent with a performance-based termination and undercuts pretext.',
    blockingClaims: [
      'wrongful-termination-public-policy',
      'age-feha',
      'disability-medical-feha',
      'retaliation-feha',
    ],
    suggestedSources: [
      'Post-notice messages from manager or HRBP about handoff, transition, or finishing a project',
    ],
    check: (s) => s.profile.signals.askedToStayAndTransition === undefined,
  },
  {
    id: 'medical-knowledge-timing',
    priority: 1,
    title: 'Did the employer know of a medical issue / leave need before the decision was final?',
    whyNeeded:
      'Knowledge element for FEHA § 12940(a) disability discrimination and § 12940(m)/(n) accommodation / interactive-process claims.',
    blockingClaims: ['disability-medical-feha', 'failure-to-accommodate', 'failure-interactive-process'],
    suggestedSources: [
      'Email to manager/HRBP disclosing medical condition',
      'Slack where a leave or accommodation was discussed',
      'Doctor note or FMLA/CFRA form',
    ],
    check: (s) => s.profile.signals.employerKnewOfMedicalBeforeDecision === undefined,
  },
  {
    id: 'shifting-reasons-missing',
    priority: 1,
    title: 'Have you captured every stated reason and when each was given?',
    whyNeeded:
      'Shifting explanations over time are classic pretext evidence. Guidance: capture each version with date and source.',
    blockingClaims: [
      'age-feha',
      'disability-medical-feha',
      'retaliation-feha',
      'wrongful-termination-public-policy',
      'cfra-interference',
    ],
    suggestedSources: [
      'Termination letter',
      'Separation-meeting notes',
      'Severance / release agreement recitals',
      'Any HRBP or manager email referring to the reason',
    ],
    check: (s) => (s.profile.signals.statedReasonsTimeline?.length ?? 0) < 2,
  },
  {
    id: 'ageist-remarks-log',
    priority: 1,
    title: 'Have you logged any ageist remarks with date / place / exact words / witnesses?',
    whyNeeded: 'Direct evidence pathway under FEHA § 12940(a) / ADEA.',
    blockingClaims: ['age-feha', 'discrimination-adea'],
    suggestedSources: [
      'Your own contemporaneous notes',
      'Email/Slack where coded ageist language appears ("fresh perspective," "energy," "new blood")',
    ],
    check: (s) =>
      s.profile.suspectedClaims.includes('age-feha') &&
      (s.profile.signals.ageistRemarks?.length ?? 0) === 0,
  },
  {
    id: 'equity-exercise-window',
    priority: 1,
    title: 'What is the post-termination option exercise window?',
    whyNeeded:
      'Often the largest economic lever in severance negotiation. Extending the window can be worth more than cash severance.',
    suggestedSources: [
      'Your grant agreement (Section on post-termination exercise)',
      'Equity-plan document',
      'Notice-of-grant PDF from Carta/Shareworks',
    ],
    check: (s) => !s.profile.signals.equityExerciseWindow,
  },
  {
    id: 'arbitration-agreement-status',
    priority: 2,
    title: 'Arbitration agreement — signed? obtained the full copy?',
    whyNeeded:
      'Determines forum (arbitration vs. court). CA Armendariz / EFAA factors govern enforceability; important for counsel\'s strategy.',
    suggestedSources: [
      'Onboarding packet PDF',
      'HR portal "employment documents" section',
      'DocuSign envelope in your personal email',
    ],
    check: (s) =>
      s.profile.employee.hasArbitrationAgreement === undefined ||
      (s.profile.employee.hasArbitrationAgreement === true &&
        !hasCollectedItem(s, 'Arbitration agreement')),
  },
  {
    id: 'replacement-identity',
    priority: 2,
    title: 'Who replaced you (if known, and only from personal knowledge)?',
    whyNeeded: 'Replacement-comparator evidence for age-feha / ADEA disparate treatment.',
    blockingClaims: ['age-feha', 'discrimination-adea'],
    suggestedSources: [
      'Org-announcement email',
      'LinkedIn role listing',
      'Public press release / all-hands deck',
    ],
    check: (s) =>
      (s.profile.suspectedClaims.includes('age-feha') ||
        s.profile.suspectedClaims.includes('discrimination-adea')) &&
      !hasCollectedItem(s, 'Replacement identity'),
  },
  {
    id: 'interactive-process-record',
    priority: 2,
    title: 'Record of interactive-process meetings / exchanges',
    whyNeeded: 'FEHA § 12940(n) duty — employer must engage in good-faith interactive process.',
    blockingClaims: ['failure-interactive-process', 'failure-to-accommodate'],
    suggestedSources: [
      'Calendar invites for accommodation discussions',
      'Email thread about accommodation options',
      'Any employer-provided form for accommodation requests',
    ],
    check: (s) =>
      s.profile.suspectedClaims.includes('failure-interactive-process') &&
      !hasCollectedItem(s, 'interactive-process', /* byCategory */ true),
  },
  {
    id: 'personnel-file-request',
    priority: 2,
    title: 'Have you requested your personnel file under Cal. Lab. Code § 1198.5?',
    whyNeeded: 'CA employer must produce within 30 days of written request. Recovers reviews, PIPs, calibration notes.',
    suggestedSources: [
      'Template written request to HR citing § 1198.5',
      'HR portal request form (if exists)',
    ],
    check: (s) => !hasCollectedItem(s, 'Personnel-file request'),
  },
  {
    id: 'payroll-records-request',
    priority: 2,
    title: 'Have you requested payroll records under Cal. Lab. Code § 226(b)?',
    whyNeeded: 'CA employer must produce wage statements and time records within 21 days.',
    suggestedSources: ['Template written request to payroll/HR citing § 226(b)'],
    check: (s) => !hasCollectedItem(s, 'Payroll-records request'),
  },
  {
    id: 'cobra-notice',
    priority: 3,
    title: 'COBRA notice received and election timing captured?',
    whyNeeded: '60-day election window; continuity of health coverage matters for damages modeling.',
    suggestedSources: ['Benefits-admin (Sequoia/Justworks/etc.) notice', 'COBRA administrator packet'],
    check: (s) => !hasCollectedItem(s, 'COBRA'),
  },
  {
    id: 'final-paycheck-timing',
    priority: 3,
    title: 'Final paycheck — when was it issued?',
    whyNeeded:
      'Cal. Lab. Code § 201 requires immediate payment on involuntary termination; § 203 waiting-time penalties up to 30 days.',
    suggestedSources: ['Final pay stub', 'Direct-deposit confirmation timestamp'],
    check: (s) => !hasCollectedItem(s, 'Final-paycheck'),
  },
];

function hasCollectedItem(state: CaseState, needle: string, byCategory = false): boolean {
  const n = needle.toLowerCase();
  return state.checklist.some((i: ChecklistItem) => {
    if (i.status !== 'collected' && i.status !== 'have') return false;
    if (byCategory) return i.category.toLowerCase().includes(n);
    return i.description.toLowerCase().includes(n);
  });
}

export function gapReport(state: CaseState, input: GapReportInput): GapReportOutput {
  const includeLowPriority = input.include_low_priority ?? false;
  const suspected = new Set(state.profile.suspectedClaims);

  const gaps: Gap[] = GAP_RULES.filter((r) => {
    if (!r.check(state)) return false;
    if (r.blockingClaims && r.blockingClaims.length > 0) {
      const relevant = r.blockingClaims.some((c) => suspected.has(c));
      if (!relevant && !includeLowPriority) return false;
    }
    return true;
  }).map((r) => ({
    id: r.id,
    priority: r.priority,
    title: r.title,
    why_needed: r.whyNeeded,
    blocking_claims: r.blockingClaims,
    suggested_sources: r.suggestedSources,
  }));

  // Sort by priority (1 highest), then by id for stability.
  gaps.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const high = gaps.filter((g) => g.priority === 1).length;
  const med = gaps.filter((g) => g.priority === 2).length;
  const low = gaps.filter((g) => g.priority === 3).length;

  // Coverage score: how many of the rules that APPLY are satisfied.
  const applicableRules = GAP_RULES.filter((r) => {
    if (r.blockingClaims && r.blockingClaims.length > 0) {
      const relevant = r.blockingClaims.some((c) => suspected.has(c));
      if (!relevant && !includeLowPriority) return false;
    }
    return true;
  });
  const totalApplicable = applicableRules.length;
  const satisfied = totalApplicable - gaps.length;
  const coverage = totalApplicable > 0 ? Math.round((satisfied / totalApplicable) * 100) : 100;

  const notes: string[] = [];
  if (high > 0) {
    notes.push(
      `${high} high-priority gap(s) remaining — these are load-bearing facts for the claims currently suspected. Close these first.`,
    );
  }
  if (gaps.length === 0) {
    notes.push(
      'No gaps detected against the current rule set. This does NOT mean the case is complete — counsel may identify additional facts that matter for your specific situation.',
    );
  }

  return {
    gaps,
    summary: {
      total: gaps.length,
      high_priority: high,
      medium_priority: med,
      low_priority: low,
      coverage_score: coverage,
    },
    notes_to_user: notes,
  };
}
