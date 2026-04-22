import type {
  CaseState,
  ClaimType,
  Jurisdiction,
} from '../../lib/case-state.js';
import { ALL_CLAIM_TYPES } from '../../lib/case-state.js';

export interface IntakeInterviewInput {
  employer_name?: string;
  employer_hq_state?: string;
  employer_employee_count?: number;
  employee_role?: string;
  start_date?: string;
  end_date?: string;
  at_will?: boolean;
  has_written_contract?: boolean;
  has_arbitration_agreement?: boolean;
  jurisdiction?: Jurisdiction;
  protected_classes?: string[];
  protected_activity?: string[];
  termination_narrative?: string;
  suspected_claims?: string[];
  notes?: string[];
  mark_complete?: boolean;
}

export interface IntakeInterviewOutput {
  profile: CaseState['profile'];
  remaining_questions: string[];
  notes_to_user: string[];
}

const JURISDICTIONS: Jurisdiction[] = ['CA', 'other', 'unknown'];
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

function validateJurisdiction(j: string | undefined): Jurisdiction | undefined {
  if (!j) return undefined;
  return (JURISDICTIONS as string[]).includes(j) ? (j as Jurisdiction) : undefined;
}

function remainingQuestions(state: CaseState): string[] {
  const q: string[] = [];
  const { profile } = state;
  if (!profile.employer.name) q.push("What is your employer's name?");
  if (!profile.employer.hqState)
    q.push("In what state is your employer's HQ (or your primary worksite)?");
  if (profile.employer.employeeCount === undefined)
    q.push(
      "Roughly how many US employees does your employer have? (Matters for Title VII ≥15, ADEA ≥20, WARN ≥100 thresholds.)",
    );
  if (!profile.employee.role) q.push('What was your role / job title?');
  if (!profile.employee.startDate) q.push('When did you start (approx date)?');
  if (!profile.employee.endDate)
    q.push('When were you terminated, or when do you expect to be?');
  if (profile.employee.atWill === undefined)
    q.push('Were you at-will, or did you have a written employment contract?');
  if (profile.employee.hasArbitrationAgreement === undefined)
    q.push('Did you sign an arbitration agreement?');
  if (profile.jurisdiction === 'unknown')
    q.push(
      'Which jurisdiction applies — California, another state, or unsure? (This agent focuses on CA + federal law.)',
    );
  if (profile.protectedClasses.length === 0)
    q.push(
      'Do you belong to any protected class relevant to the termination? (age 40+, race, sex/gender, pregnancy, disability, sexual orientation, national origin, religion, etc.)',
    );
  if (profile.protectedActivity.length === 0)
    q.push(
      'In the months before termination, did you engage in any protected activity — complaining about harassment/discrimination, requesting an accommodation, taking leave, raising a wage issue, or reporting something you believed was illegal?',
    );
  if (!profile.terminationNarrative)
    q.push(
      'In a few sentences, what happened? Who told you, when, and what reason did they give?',
    );
  if (profile.suspectedClaims.length === 0)
    q.push(
      `Which of these claim types feel most relevant? (${ALL_CLAIM_TYPES.join(', ')}) — best guesses are fine.`,
    );
  return q;
}

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
    },
  };
  const p = next.profile;

  if (input.employer_name !== undefined) p.employer.name = input.employer_name;
  if (input.employer_hq_state !== undefined) p.employer.hqState = input.employer_hq_state;
  if (input.employer_employee_count !== undefined)
    p.employer.employeeCount = input.employer_employee_count;

  if (input.employee_role !== undefined) p.employee.role = input.employee_role;
  if (input.start_date !== undefined) p.employee.startDate = input.start_date;
  if (input.end_date !== undefined) p.employee.endDate = input.end_date;
  if (input.at_will !== undefined) p.employee.atWill = input.at_will;
  if (input.has_written_contract !== undefined)
    p.employee.hasWrittenContract = input.has_written_contract;
  if (input.has_arbitration_agreement !== undefined)
    p.employee.hasArbitrationAgreement = input.has_arbitration_agreement;

  const j = validateJurisdiction(input.jurisdiction);
  if (j) p.jurisdiction = j;

  p.protectedClasses = mergeList(p.protectedClasses, input.protected_classes);
  p.protectedActivity = mergeList(p.protectedActivity, input.protected_activity);

  if (input.termination_narrative !== undefined)
    p.terminationNarrative = input.termination_narrative;

  const notesToUser: string[] = [];
  const { valid, unknown } = coerceClaims(input.suspected_claims);
  if (valid.length) {
    const claimSet = new Set<ClaimType>([...p.suspectedClaims, ...valid]);
    p.suspectedClaims = Array.from(claimSet);
  }
  if (unknown.length) {
    notesToUser.push(
      `Ignored unrecognized claim types: ${unknown.join(', ')}. Valid values: ${ALL_CLAIM_TYPES.join(', ')}.`,
    );
  }

  if (input.notes?.length) {
    p.notes = mergeList(p.notes, input.notes);
  }

  if (p.jurisdiction === 'other') {
    notesToUser.push(
      'Jurisdiction is outside California. This agent focuses on CA + US federal law; the checklist may not cover state-specific items. Please engage local counsel.',
    );
  }

  if (input.mark_complete) p.intakeComplete = true;

  const remaining = remainingQuestions(next);
  if (remaining.length === 0 && !p.intakeComplete) {
    notesToUser.push(
      'All core intake questions answered. You can call intake_interview again with mark_complete=true, or proceed to build_evidence_plan.',
    );
  }

  return {
    state: next,
    output: {
      profile: next.profile,
      remaining_questions: remaining,
      notes_to_user: notesToUser,
    },
  };
}
