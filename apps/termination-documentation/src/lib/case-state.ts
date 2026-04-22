/**
 * Per-user case state persisted in the Durable Object.
 *
 * Storage is versioned — v1 was the initial scaffold shape, v2 adds
 * CA-specific claim taxonomy, signal-flagged items, richer evidence
 * metadata, and a ProfileSignals sub-object for the high-value patterns.
 *
 * Not legal advice. Statute citations are included so the user's counsel
 * can see why each item matters.
 */

// ── Claim taxonomy ────────────────────────────────────────────────────────────
//
// CA-first: FEHA Gov. Code § 12940 family, CFRA, Tameny. Federal siblings
// kept because they provide distinct remedies (ADEA liquidated damages, fee
// shifting, etc.).

export type ClaimType =
  // California — FEHA
  | 'age-feha' // Gov. Code § 12940(a)
  | 'disability-medical-feha' // Gov. Code § 12940(a) (physical/mental/medical condition)
  | 'failure-to-accommodate' // Gov. Code § 12940(m)
  | 'failure-interactive-process' // Gov. Code § 12940(n)
  | 'retaliation-feha' // Gov. Code § 12940(h)
  | 'harassment-feha' // Gov. Code § 12940(j)
  // California — other
  | 'cfra-interference' // Gov. Code § 12945.2 (leave interference/retaliation)
  | 'wrongful-termination-public-policy' // Tameny
  | 'whistleblower-1102.5' // Cal. Lab. Code § 1102.5
  | 'wage-hour' // Cal. Lab. Code §§ 201–204, 226, 2802, etc.
  | 'warn-cal-warn' // Cal. Lab. Code § 1401
  // Federal siblings
  | 'discrimination-title-vii'
  | 'discrimination-adea'
  | 'disability-ada'
  | 'fmla-interference'
  // Catch-all
  | 'other';

export const ALL_CLAIM_TYPES: ClaimType[] = [
  'age-feha',
  'disability-medical-feha',
  'failure-to-accommodate',
  'failure-interactive-process',
  'retaliation-feha',
  'harassment-feha',
  'cfra-interference',
  'wrongful-termination-public-policy',
  'whistleblower-1102.5',
  'wage-hour',
  'warn-cal-warn',
  'discrimination-title-vii',
  'discrimination-adea',
  'disability-ada',
  'fmla-interference',
  'other',
];

// ── Categories ────────────────────────────────────────────────────────────────
//
// Mirrors the guidance's A–G taxonomy with a few extensions for CA-specific
// evidence buckets (interactive-process, age-evidence).

export type ChecklistCategory =
  | 'employment-terms'
  | 'performance'
  | 'adverse-action-separation'
  | 'medical-leave-accommodation'
  | 'interactive-process'
  | 'age-evidence'
  | 'comms'
  | 'hr-process'
  | 'protected-activity'
  | 'comparators'
  | 'financial'
  | 'witnesses'
  | 'exit-artifacts';

export const ALL_CATEGORIES: ChecklistCategory[] = [
  'employment-terms',
  'performance',
  'adverse-action-separation',
  'medical-leave-accommodation',
  'interactive-process',
  'age-evidence',
  'comms',
  'hr-process',
  'protected-activity',
  'comparators',
  'financial',
  'witnesses',
  'exit-artifacts',
];

// ── Signal flags ─────────────────────────────────────────────────────────────
//
// Facets on a checklist item marking a high-value legal pattern. Items with
// signal flags float to the top of the "Top-N packet" and the negotiation
// memo leverage points.

export type SignalFlag =
  | 'praise-before-termination'
  | 'no-pip-or-progressive-discipline'
  | 'asked-to-stay-and-transition'
  | 'employer-knew-of-medical-before-decision'
  | 'shifting-explanation'
  | 'adverse-close-to-protected-activity'
  | 'ageist-remark-from-decisionmaker'
  | 'deviation-from-policy'
  | 'decisionmaker-communication'
  | 'damages-equity-exercise-window';

export const ALL_SIGNAL_FLAGS: SignalFlag[] = [
  'praise-before-termination',
  'no-pip-or-progressive-discipline',
  'asked-to-stay-and-transition',
  'employer-knew-of-medical-before-decision',
  'shifting-explanation',
  'adverse-close-to-protected-activity',
  'ageist-remark-from-decisionmaker',
  'deviation-from-policy',
  'decisionmaker-communication',
  'damages-equity-exercise-window',
];

// ── Source type ──────────────────────────────────────────────────────────────

export type SourceType =
  | 'email'
  | 'slack'
  | 'teams'
  | 'text'
  | 'calendar'
  | 'review'
  | 'paystub'
  | 'note'
  | 'doctor-note'
  | 'hr-portal'
  | 'agreement'
  | 'handbook'
  | 'other';

export const ALL_SOURCE_TYPES: SourceType[] = [
  'email',
  'slack',
  'teams',
  'text',
  'calendar',
  'review',
  'paystub',
  'note',
  'doctor-note',
  'hr-portal',
  'agreement',
  'handbook',
  'other',
];

export type ChecklistStatus =
  | 'pending'
  | 'have'
  | 'collected'
  | 'unavailable'
  | 'skipped';

export type LocationHint =
  | 'work-laptop'
  | 'personal-email'
  | 'personal-phone'
  | 'hr-portal'
  | 'payroll-portal'
  | 'paper'
  | 'other';

export type Score = 1 | 2 | 3 | 4 | 5;

export interface ItemScores {
  /** How much this item moves the needle toward proving a claim. */
  relevance?: Score;
  /** How authoritative / hard to dispute — contemporaneous, from decisionmaker, etc. */
  reliability?: Score;
  /** How close in time to the adverse action. */
  timingProximity?: Score;
  /** Higher = more legal or professional risk to possess. 1 = safely yours; 5 = do not export, memorialize instead. */
  confidentialityRisk?: Score;
}

export interface ItemAuthor {
  name?: string;
  role?: string;
  isDecisionmaker?: boolean;
}

export interface ChecklistItem {
  id: string;
  category: ChecklistCategory;
  description: string;
  statuteHook?: string;
  status: ChecklistStatus;
  locationHint?: LocationHint;
  driveFileId?: string;
  notes?: string;
  custom?: boolean;

  // v2 evidence-index fields (all optional — populated as items are collected)
  fileName?: string;
  sourceType?: SourceType;
  /** ISO date the document was created. */
  dateCreated?: string;
  /** ISO date of the event the document describes (may differ from dateCreated). */
  dateEvent?: string;
  author?: ItemAuthor;
  recipients?: string[];
  exactQuotes?: string[];
  whyItMatters?: string;
  claimTags?: ClaimType[];
  scores?: ItemScores;
  /** Whether the user has the original file (with headers/metadata intact). */
  preserveOriginal?: boolean;
  authenticityNotes?: string;
  signalFlags?: SignalFlag[];
}

export interface EmployerInfo {
  name?: string;
  hqState?: string;
  /** U.S. employee count — matters for Title VII / ADEA / WARN thresholds. */
  employeeCount?: number;
}

export interface EmployeeInfo {
  role?: string;
  startDate?: string;
  endDate?: string;
  atWill?: boolean;
  hasWrittenContract?: boolean;
  hasArbitrationAgreement?: boolean;
  /** Employee age — matters for FEHA/ADEA (40+). */
  age?: number;
}

// ── High-value signal patterns on the profile ────────────────────────────────

export interface StatedReasonEntry {
  /** Date the reason was communicated (ISO). */
  date?: string;
  reason: string;
  source?: string;
}

export interface AgeistRemark {
  date?: string;
  place?: string;
  remarker?: string;
  exactWords?: string;
  witnesses?: string[];
}

export interface ProfileSignals {
  /** Recent written praise (quotes or paraphrase + dates). */
  recentPraiseExamples?: string[];
  /** Bonus percent of target for the most recent cycle. */
  recentBonusPercent?: number;
  /** Last performance rating (verbatim string). */
  lastReviewRating?: string;
  /** Was there a PIP or progressive-discipline process? */
  hadPipOrProgressiveDiscipline?: boolean;
  pipNarrative?: string;
  /** Was the employee asked to stay and transition after being told employment is ending? */
  askedToStayAndTransition?: boolean;
  askedToStayNarrative?: string;
  /** Did the employer know about a medical issue or possible leave before the termination decision was final? */
  employerKnewOfMedicalBeforeDecision?: boolean;
  medicalKnowledgeNarrative?: string;
  /** Shifting explanations over time. */
  statedReasonsTimeline?: StatedReasonEntry[];
  /** Any ageist remarks by decisionmakers. */
  ageistRemarks?: AgeistRemark[];
  /** Option exercise window terms post-termination (e.g., "90 days from separation"). */
  equityExerciseWindow?: string;
  /** Unvested equity forfeited on separation, estimated dollar value. */
  unvestedEquityValue?: number;
}

export interface CaseProfile {
  createdAt: string;
  updatedAt: string;
  jurisdiction: 'CA' | 'other' | 'unknown';
  employer: EmployerInfo;
  employee: EmployeeInfo;
  /** Free-form labels like "age_40+", "pregnancy", "disability_mental_health". */
  protectedClasses: string[];
  /** Free-form labels like "reported_harassment", "requested_accommodation", "raised_wage_issue". */
  protectedActivity: string[];
  terminationNarrative?: string;
  suspectedClaims: ClaimType[];
  notes: string[];
  signals: ProfileSignals;
  intakeComplete: boolean;
}

export interface DriveRefs {
  rootFolderId?: string;
  subfolderIds: Partial<Record<ChecklistCategory, string>>;
}

export interface MemoRef {
  docId?: string;
  lastUpdatedAt?: string;
}

export type ExitTaskStatus = 'pending' | 'done' | 'skipped';

export interface ExitTask {
  id: string;
  description: string;
  rationale: string;
  status: ExitTaskStatus;
}

export interface CaseState {
  schemaVersion: 2;
  profile: CaseProfile;
  checklist: ChecklistItem[];
  drive: DriveRefs;
  memo: MemoRef;
  exitTasks: ExitTask[];
}

// ── Load / save / migrate ────────────────────────────────────────────────────

const V1_KEY = 'case_state_v1';
const V2_KEY = 'case_state_v2';

export function emptyCaseState(): CaseState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    profile: {
      createdAt: now,
      updatedAt: now,
      jurisdiction: 'unknown',
      employer: {},
      employee: {},
      protectedClasses: [],
      protectedActivity: [],
      suspectedClaims: [],
      notes: [],
      signals: {},
      intakeComplete: false,
    },
    checklist: [],
    drive: { subfolderIds: {} },
    memo: {},
    exitTasks: [],
  };
}

export async function loadCaseState(storage: DurableObjectStorage): Promise<CaseState> {
  const v2 = await storage.get<CaseState>(V2_KEY);
  if (v2) return ensureV2Shape(v2);

  // Legacy v1 → migrate on read.
  const v1 = await storage.get<unknown>(V1_KEY);
  if (!v1 || typeof v1 !== 'object') return emptyCaseState();

  const migrated = migrateV1ToV2(v1 as Record<string, unknown>);
  await storage.put(V2_KEY, migrated);
  await storage.delete(V1_KEY);
  return migrated;
}

export async function saveCaseState(
  storage: DurableObjectStorage,
  state: CaseState,
): Promise<void> {
  state.profile.updatedAt = new Date().toISOString();
  await storage.put(V2_KEY, state);
}

/** Stable short id usable as a checklist item id. */
export function makeChecklistId(): string {
  return `ci_${crypto.randomUUID().slice(0, 8)}`;
}

// ── Migration helpers ────────────────────────────────────────────────────────

/** Legacy claim-type map: v1 labels → v2 labels. */
const V1_CLAIM_MAP: Record<string, ClaimType | null> = {
  'wrongful-termination': 'wrongful-termination-public-policy',
  retaliation: 'retaliation-feha',
  'discrimination-title-vii': 'discrimination-title-vii',
  'discrimination-feha': 'age-feha', // best-effort; users may re-tag
  'discrimination-adea': 'discrimination-adea',
  'disability-ada-feha': 'disability-medical-feha',
  harassment: 'harassment-feha',
  'wage-hour': 'wage-hour',
  'cfra-fmla-interference': 'cfra-interference',
  'whistleblower-1102.5': 'whistleblower-1102.5',
  'warn-cal-warn': 'warn-cal-warn',
  other: 'other',
};

/** Legacy category map: v1 labels → v2 labels. */
const V1_CATEGORY_MAP: Record<string, ChecklistCategory> = {
  'employment-terms': 'employment-terms',
  performance: 'performance',
  comms: 'comms',
  'hr-process': 'hr-process',
  'protected-activity': 'protected-activity',
  comparators: 'comparators',
  financial: 'financial',
  medical: 'medical-leave-accommodation',
  witnesses: 'witnesses',
  'exit-artifacts': 'exit-artifacts',
};

function migrateV1ToV2(v1: Record<string, unknown>): CaseState {
  const v1Profile = (v1.profile ?? {}) as Record<string, unknown>;
  const v1Checklist = Array.isArray(v1.checklist) ? (v1.checklist as Record<string, unknown>[]) : [];

  const migratedClaims: ClaimType[] = [];
  for (const c of Array.isArray(v1Profile.suspectedClaims) ? (v1Profile.suspectedClaims as string[]) : []) {
    const mapped = V1_CLAIM_MAP[c];
    if (mapped && !migratedClaims.includes(mapped)) migratedClaims.push(mapped);
  }

  const migratedChecklist: ChecklistItem[] = v1Checklist.map((raw) => {
    const cat = typeof raw.category === 'string' ? raw.category : 'employment-terms';
    const mappedCat: ChecklistCategory = V1_CATEGORY_MAP[cat] ?? 'employment-terms';
    return {
      id: typeof raw.id === 'string' ? raw.id : makeChecklistId(),
      category: mappedCat,
      description: typeof raw.description === 'string' ? raw.description : '(migrated)',
      statuteHook: typeof raw.statuteHook === 'string' ? raw.statuteHook : undefined,
      status: (raw.status as ChecklistStatus) ?? 'pending',
      locationHint: raw.locationHint as LocationHint | undefined,
      driveFileId: typeof raw.driveFileId === 'string' ? raw.driveFileId : undefined,
      notes: typeof raw.notes === 'string' ? raw.notes : undefined,
      custom: raw.custom === true,
    };
  });

  const v1Employer = (v1Profile.employer ?? {}) as Record<string, unknown>;
  const v1Employee = (v1Profile.employee ?? {}) as Record<string, unknown>;

  const state = emptyCaseState();
  state.profile = {
    ...state.profile,
    createdAt: typeof v1Profile.createdAt === 'string' ? v1Profile.createdAt : state.profile.createdAt,
    updatedAt: new Date().toISOString(),
    jurisdiction: (v1Profile.jurisdiction as 'CA' | 'other' | 'unknown' | undefined) ?? 'unknown',
    employer: {
      name: typeof v1Employer.name === 'string' ? v1Employer.name : undefined,
      hqState: typeof v1Employer.hqState === 'string' ? v1Employer.hqState : undefined,
      employeeCount:
        typeof v1Employer.employeeCount === 'number' ? v1Employer.employeeCount : undefined,
    },
    employee: {
      role: typeof v1Employee.role === 'string' ? v1Employee.role : undefined,
      startDate: typeof v1Employee.startDate === 'string' ? v1Employee.startDate : undefined,
      endDate: typeof v1Employee.endDate === 'string' ? v1Employee.endDate : undefined,
      atWill: typeof v1Employee.atWill === 'boolean' ? v1Employee.atWill : undefined,
      hasWrittenContract:
        typeof v1Employee.hasWrittenContract === 'boolean'
          ? v1Employee.hasWrittenContract
          : undefined,
      hasArbitrationAgreement:
        typeof v1Employee.hasArbitrationAgreement === 'boolean'
          ? v1Employee.hasArbitrationAgreement
          : undefined,
    },
    protectedClasses: Array.isArray(v1Profile.protectedClasses)
      ? (v1Profile.protectedClasses as string[])
      : [],
    protectedActivity: Array.isArray(v1Profile.protectedActivity)
      ? (v1Profile.protectedActivity as string[])
      : [],
    terminationNarrative:
      typeof v1Profile.terminationNarrative === 'string'
        ? v1Profile.terminationNarrative
        : undefined,
    suspectedClaims: migratedClaims,
    notes: Array.isArray(v1Profile.notes) ? (v1Profile.notes as string[]) : [],
    intakeComplete: v1Profile.intakeComplete === true,
  };
  state.checklist = migratedChecklist;
  return state;
}

/** Defensive shape check for v2 reads — fills in any fields a pre-merge deploy might have written as undefined. */
function ensureV2Shape(s: CaseState): CaseState {
  return {
    ...s,
    schemaVersion: 2,
    profile: {
      ...s.profile,
      signals: s.profile.signals ?? {},
      notes: s.profile.notes ?? [],
      protectedClasses: s.profile.protectedClasses ?? [],
      protectedActivity: s.profile.protectedActivity ?? [],
      suspectedClaims: s.profile.suspectedClaims ?? [],
    },
    checklist: s.checklist ?? [],
    drive: s.drive ?? { subfolderIds: {} },
    memo: s.memo ?? {},
    exitTasks: s.exitTasks ?? [],
  };
}
