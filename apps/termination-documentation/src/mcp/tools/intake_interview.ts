import {
  ALL_CLAIM_TYPES,
  type AgeistRemark,
  type CaseState,
  type ClaimType,
  type ProfileSignals,
  type StatedReasonEntry,
} from '../../lib/case-state.js';

export interface IntakeInterviewInput {
  employer_name?: string;
  employer_hq_state?: string;
  employer_employee_count?: number;

  employee_role?: string;
  employee_age?: number;
  start_date?: string;
  end_date?: string;
  at_will?: boolean;
  has_written_contract?: boolean;
  has_arbitration_agreement?: boolean;

  jurisdiction?: 'CA' | 'other' | 'unknown';
  protected_classes?: string[];
  protected_activity?: string[];
  termination_narrative?: string;
  suspected_claims?: string[];
  notes?: string[];

  // ── High-value signal patterns ──────────────────────────────────────────
  /** Recent written praise quotes or paraphrases (ideally with date + author). */
  recent_praise_examples?: string[];
  /** Bonus % of target for the most recent cycle (e.g. 127). */
  recent_bonus_percent?: number;
  /** Last performance rating, verbatim (e.g. "Exceeds Expectations"). */
  last_review_rating?: string;
  /** Was there a PIP or formal progressive-discipline process? */
  had_pip_or_progressive_discipline?: boolean;
  pip_narrative?: string;
  /** Were you asked to stay and transition after being told employment is ending? */
  asked_to_stay_and_transition?: boolean;
  asked_to_stay_narrative?: string;
  /** Did the employer know about a medical issue / possible leave before the decision was final? */
  employer_knew_of_medical_before_decision?: boolean;
  medical_knowledge_narrative?: string;
  /** Shifting explanations: append one or more entries. */
  stated_reasons_timeline?: StatedReasonEntry[];
  /** Ageist remarks by decisionmakers — date/place/remarker/exactWords/witnesses. */
  ageist_remarks?: AgeistRemark[];
  /** Post-termination option exercise window (e.g. "90 days from separation"). */
  equity_exercise_window?: string;
  /** Estimated dollar value of unvested equity forfeited on separation. */
  unvested_equity_value?: number;

  mark_complete?: boolean;
}

export interface IntakeInterviewOutput {
  profile: CaseState['profile'];
  remaining_questions: string[];
  /** Claim types the agent suggests based on answers so far. User / counsel decide what sticks. */
  suggested_claim_additions: Array<{ claim: ClaimType; because: string }>;
  notes_to_user: string[];
}

const JURISDICTIONS = new Set(['CA', 'other', 'unknown']);
const KNOWN_CLAIMS = new Set<ClaimType>(ALL_CLAIM_TYPES);

function mergeList(existing: string[], incoming: string[] | undefined): string[] {
  if (!incoming) return existing;
  const set = new Set([...existing, ...incoming.filter((s) => s && s.trim().length > 0)]);
  return Array.from(set);
}

function coerceClaims(input: string[] | undefined): {
  valid: ClaimType[];
  unknown: string[];
} {
  if (!input) return { valid: [], unknown: [] };
  const valid: ClaimType[] = [];
  const unknown: string[] = [];
  for (const c of input) {
    if (KNOWN_CLAIMS.has(c as ClaimType)) valid.push(c as ClaimType);
    else unknown.push(c);
  }
  return { valid, unknown };
}

// ── Question library ─────────────────────────────────────────────────────────
// Ordered by value; intake_interview returns the next N unanswered to guide
// the model's next prompt.

function remainingQuestions(state: CaseState): string[] {
  const q: string[] = [];
  const { profile } = state;
  const s = profile.signals;

  // Foundation
  if (!profile.employer.name) q.push("What is your employer's name?");
  if (!profile.employer.hqState)
    q.push("In what state is your employer's HQ (or your primary worksite)?");
  if (profile.employer.employeeCount === undefined)
    q.push(
      'Roughly how many US employees does your employer have? (Affects Title VII ≥15, ADEA ≥20, WARN ≥100 thresholds.)',
    );
  if (!profile.employee.role) q.push('What was your role / job title?');
  if (profile.employee.age === undefined)
    q.push('What is your age? (Age 40+ triggers FEHA § 12940(a) and ADEA protections.)');
  if (!profile.employee.startDate) q.push('When did you start (approx date)?');
  if (!profile.employee.endDate)
    q.push('When were you terminated, or when do you expect to be?');
  if (profile.employee.hasArbitrationAgreement === undefined)
    q.push('Did you sign an arbitration agreement?');
  if (profile.jurisdiction === 'unknown')
    q.push('Which jurisdiction applies — California, another state, or unsure?');

  // High-value signal questions (ask these early — they drive everything else)
  if (s.recentPraiseExamples === undefined || s.recentPraiseExamples.length === 0)
    q.push(
      'What recent written praise have you received from your manager, skip-level, or HRBP? (Exact language + dates, or at least recent quotes.)',
    );
  if (s.recentBonusPercent === undefined)
    q.push('What was your most recent bonus, as a percent of target (e.g. 127%)?');
  if (!s.lastReviewRating)
    q.push('What was your most recent performance rating (verbatim, e.g. "Exceeds Expectations")?');
  if (s.hadPipOrProgressiveDiscipline === undefined)
    q.push('Were you ever placed on a PIP or given a formal written warning?');
  if (s.askedToStayAndTransition === undefined)
    q.push(
      'After being told employment was ending, were you asked to stay and transition, hand off work, or finish a project?',
    );
  if (s.employerKnewOfMedicalBeforeDecision === undefined)
    q.push(
      'Did the employer know about a medical issue, a need for leave, or an accommodation request before the termination decision was final? If so, who knew and when?',
    );
  if (profile.protectedClasses.length === 0)
    q.push(
      'Do you belong to any protected class relevant to the termination? (age 40+, race, sex/gender, pregnancy, disability, medical condition, sexual orientation, national origin, religion, etc.)',
    );
  if (profile.protectedActivity.length === 0)
    q.push(
      'In the months before termination, did you engage in any protected activity — complaining about harassment/discrimination, requesting an accommodation, taking leave, raising a wage issue, or reporting something you believed illegal?',
    );
  if (!s.statedReasonsTimeline || s.statedReasonsTimeline.length === 0)
    q.push(
      'What reason has the employer given for the termination? Has the explanation shifted over time (performance vs. restructuring vs. fit vs. timing)?',
    );
  if (
    (profile.employee.age ?? 0) >= 40 &&
    (!s.ageistRemarks || s.ageistRemarks.length === 0)
  )
    q.push(
      'Have any decisionmakers made age-related remarks? (Date, place, exact words if you remember, who was present.)',
    );
  if (!s.equityExerciseWindow)
    q.push(
      'What are the post-termination option exercise window terms in your grant agreement (e.g. 90 days from separation)? This is often the largest damages lever.',
    );
  if (!profile.terminationNarrative)
    q.push('In a few sentences: what happened? Who told you, when, and what reason did they give?');
  if (profile.suspectedClaims.length === 0)
    q.push(
      `Which claim types feel most relevant? Best guesses are fine — valid values: ${ALL_CLAIM_TYPES.join(', ')}.`,
    );

  return q;
}

// ── Auto-suggest claims based on signals ────────────────────────────────────

function suggestClaims(profile: CaseState['profile']): Array<{ claim: ClaimType; because: string }> {
  const existing = new Set(profile.suspectedClaims);
  const out: Array<{ claim: ClaimType; because: string }> = [];
  const s = profile.signals;
  const hasAdverse = !!profile.employee.endDate;
  const age = profile.employee.age ?? 0;

  const suggest = (claim: ClaimType, because: string) => {
    if (existing.has(claim)) return;
    if (out.some((x) => x.claim === claim)) return;
    out.push({ claim, because });
  };

  // Age
  if (age >= 40 && hasAdverse) {
    suggest(
      'age-feha',
      'You are in the FEHA age-protected class (40+) and reported an adverse action.',
    );
    suggest('discrimination-adea', 'Federal ADEA sibling to age-feha — adds liquidated damages if willful.');
  }
  if ((s.ageistRemarks?.length ?? 0) > 0) {
    suggest('age-feha', 'You reported age-related remarks by decisionmakers.');
  }

  // Medical / disability / accommodation
  if (s.employerKnewOfMedicalBeforeDecision === true && hasAdverse) {
    suggest(
      'disability-medical-feha',
      'Employer was on notice of a medical issue before the termination decision was final.',
    );
    suggest(
      'failure-to-accommodate',
      'If an accommodation was needed, FEHA § 12940(m) requires the employer to provide it absent undue hardship.',
    );
    suggest(
      'failure-interactive-process',
      'FEHA § 12940(n) requires a good-faith interactive process when accommodation is needed.',
    );
  }
  const activityStr = profile.protectedActivity.join(' ').toLowerCase();
  if (
    activityStr.includes('leave') ||
    activityStr.includes('cfra') ||
    activityStr.includes('fmla')
  ) {
    suggest('cfra-interference', 'You reported leave-related protected activity.');
  }

  // Retaliation — any protected activity + adverse action
  if (profile.protectedActivity.length > 0 && hasAdverse) {
    suggest(
      'retaliation-feha',
      'Protected activity close in time to adverse action triggers FEHA § 12940(h) analysis.',
    );
  }

  // Whistleblower
  if (
    activityStr.includes('whistle') ||
    activityStr.includes('report_illegal') ||
    activityStr.includes('safety') ||
    activityStr.includes('wage')
  ) {
    suggest('whistleblower-1102.5', 'You reported reporting something you believed illegal.');
  }

  // Tameny (public-policy wrongful termination) — when any statute-based adverse
  // action claim is already in play, flag Tameny so counsel can add the tort claim.
  const publicPolicyTriggers: ClaimType[] = [
    'retaliation-feha',
    'whistleblower-1102.5',
    'cfra-interference',
    'failure-to-accommodate',
    'age-feha',
    'disability-medical-feha',
  ];
  const hasPolicyTrigger =
    publicPolicyTriggers.some((c) => existing.has(c)) ||
    out.some((x) => publicPolicyTriggers.includes(x.claim));
  if (hasPolicyTrigger && hasAdverse) {
    suggest(
      'wrongful-termination-public-policy',
      'Statute-based claim + termination → Tameny common-law tort is frequently added.',
    );
  }

  return out;
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function intakeInterview(
  state: CaseState,
  input: IntakeInterviewInput,
): { state: CaseState; output: IntakeInterviewOutput } {
  const next: CaseState = {
    ...state,
    profile: {
      ...state.profile,
      employer: { ...state.profile.employer },
      employee: { ...state.profile.employee },
      protectedClasses: [...state.profile.protectedClasses],
      protectedActivity: [...state.profile.protectedActivity],
      suspectedClaims: [...state.profile.suspectedClaims],
      notes: [...state.profile.notes],
      signals: { ...state.profile.signals },
    },
  };
  const p = next.profile;
  const s: ProfileSignals = p.signals;

  // Employer
  if (input.employer_name !== undefined) p.employer.name = input.employer_name;
  if (input.employer_hq_state !== undefined) p.employer.hqState = input.employer_hq_state;
  if (input.employer_employee_count !== undefined)
    p.employer.employeeCount = input.employer_employee_count;

  // Employee
  if (input.employee_role !== undefined) p.employee.role = input.employee_role;
  if (input.employee_age !== undefined) p.employee.age = input.employee_age;
  if (input.start_date !== undefined) p.employee.startDate = input.start_date;
  if (input.end_date !== undefined) p.employee.endDate = input.end_date;
  if (input.at_will !== undefined) p.employee.atWill = input.at_will;
  if (input.has_written_contract !== undefined)
    p.employee.hasWrittenContract = input.has_written_contract;
  if (input.has_arbitration_agreement !== undefined)
    p.employee.hasArbitrationAgreement = input.has_arbitration_agreement;

  // Jurisdiction + classes + activity
  if (input.jurisdiction && JURISDICTIONS.has(input.jurisdiction))
    p.jurisdiction = input.jurisdiction;
  p.protectedClasses = mergeList(p.protectedClasses, input.protected_classes);
  p.protectedActivity = mergeList(p.protectedActivity, input.protected_activity);

  if (input.termination_narrative !== undefined)
    p.terminationNarrative = input.termination_narrative;

  // Signals
  if (input.recent_praise_examples !== undefined)
    s.recentPraiseExamples = mergeList(s.recentPraiseExamples ?? [], input.recent_praise_examples);
  if (input.recent_bonus_percent !== undefined) s.recentBonusPercent = input.recent_bonus_percent;
  if (input.last_review_rating !== undefined) s.lastReviewRating = input.last_review_rating;
  if (input.had_pip_or_progressive_discipline !== undefined)
    s.hadPipOrProgressiveDiscipline = input.had_pip_or_progressive_discipline;
  if (input.pip_narrative !== undefined) s.pipNarrative = input.pip_narrative;
  if (input.asked_to_stay_and_transition !== undefined)
    s.askedToStayAndTransition = input.asked_to_stay_and_transition;
  if (input.asked_to_stay_narrative !== undefined)
    s.askedToStayNarrative = input.asked_to_stay_narrative;
  if (input.employer_knew_of_medical_before_decision !== undefined)
    s.employerKnewOfMedicalBeforeDecision = input.employer_knew_of_medical_before_decision;
  if (input.medical_knowledge_narrative !== undefined)
    s.medicalKnowledgeNarrative = input.medical_knowledge_narrative;
  if (input.stated_reasons_timeline?.length)
    s.statedReasonsTimeline = [
      ...(s.statedReasonsTimeline ?? []),
      ...input.stated_reasons_timeline,
    ];
  if (input.ageist_remarks?.length)
    s.ageistRemarks = [...(s.ageistRemarks ?? []), ...input.ageist_remarks];
  if (input.equity_exercise_window !== undefined)
    s.equityExerciseWindow = input.equity_exercise_window;
  if (input.unvested_equity_value !== undefined)
    s.unvestedEquityValue = input.unvested_equity_value;

  // Suspected claims
  const notesToUser: string[] = [];
  const { valid, unknown } = coerceClaims(input.suspected_claims);
  if (valid.length) {
    const set = new Set<ClaimType>([...p.suspectedClaims, ...valid]);
    p.suspectedClaims = Array.from(set);
  }
  if (unknown.length) {
    notesToUser.push(
      `Ignored unrecognized claim types: ${unknown.join(', ')}. Valid values: ${ALL_CLAIM_TYPES.join(', ')}.`,
    );
  }

  // Notes
  if (input.notes?.length) {
    p.notes = mergeList(p.notes, input.notes);
  }

  if (p.jurisdiction === 'other') {
    notesToUser.push(
      'Jurisdiction is outside California. This agent focuses on CA + federal law; engage local counsel for state-specific claims.',
    );
  }

  if (input.mark_complete) p.intakeComplete = true;

  const remaining = remainingQuestions(next);
  const suggestions = suggestClaims(p);

  if (remaining.length === 0 && !p.intakeComplete) {
    notesToUser.push(
      'All intake questions answered. Call intake_interview again with mark_complete=true, or proceed to build_evidence_plan.',
    );
  }

  return {
    state: next,
    output: {
      profile: p,
      remaining_questions: remaining,
      suggested_claim_additions: suggestions,
      notes_to_user: notesToUser,
    },
  };
}
