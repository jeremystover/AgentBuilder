/**
 * Per-user case state persisted in the Durable Object.
 *
 * One DO instance per sessionId — in practice, one active case per user.
 * All mutations go through tool handlers; the model never writes state
 * directly.
 */

export type Jurisdiction = 'CA' | 'other' | 'unknown';

export type ClaimType =
  | 'wrongful-termination'
  | 'retaliation'
  | 'discrimination-title-vii'
  | 'discrimination-feha'
  | 'discrimination-adea'
  | 'disability-ada-feha'
  | 'harassment'
  | 'wage-hour'
  | 'cfra-fmla-interference'
  | 'whistleblower-1102.5'
  | 'warn-cal-warn'
  | 'other';

export const ALL_CLAIM_TYPES: ClaimType[] = [
  'wrongful-termination',
  'retaliation',
  'discrimination-title-vii',
  'discrimination-feha',
  'discrimination-adea',
  'disability-ada-feha',
  'harassment',
  'wage-hour',
  'cfra-fmla-interference',
  'whistleblower-1102.5',
  'warn-cal-warn',
  'other',
];

export type ChecklistCategory =
  | 'employment-terms'
  | 'performance'
  | 'comms'
  | 'hr-process'
  | 'protected-activity'
  | 'comparators'
  | 'financial'
  | 'medical'
  | 'witnesses'
  | 'exit-artifacts';

export const ALL_CATEGORIES: ChecklistCategory[] = [
  'employment-terms',
  'performance',
  'comms',
  'hr-process',
  'protected-activity',
  'comparators',
  'financial',
  'medical',
  'witnesses',
  'exit-artifacts',
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
}

export interface CaseProfile {
  createdAt: string;
  updatedAt: string;
  jurisdiction: Jurisdiction;
  employer: EmployerInfo;
  employee: EmployeeInfo;
  /** Free-form labels like "age_40+", "pregnancy", "disability_mental_health". */
  protectedClasses: string[];
  /** Free-form labels like "reported_harassment", "requested_accommodation", "raised_wage_issue". */
  protectedActivity: string[];
  terminationNarrative?: string;
  suspectedClaims: ClaimType[];
  notes: string[];
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
  profile: CaseProfile;
  checklist: ChecklistItem[];
  drive: DriveRefs;
  memo: MemoRef;
  exitTasks: ExitTask[];
}

const STATE_KEY = 'case_state_v1';

export function emptyCaseState(): CaseState {
  const now = new Date().toISOString();
  return {
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
      intakeComplete: false,
    },
    checklist: [],
    drive: { subfolderIds: {} },
    memo: {},
    exitTasks: [],
  };
}

export async function loadCaseState(storage: DurableObjectStorage): Promise<CaseState> {
  const stored = await storage.get<CaseState>(STATE_KEY);
  return stored ?? emptyCaseState();
}

export async function saveCaseState(
  storage: DurableObjectStorage,
  state: CaseState,
): Promise<void> {
  state.profile.updatedAt = new Date().toISOString();
  await storage.put(STATE_KEY, state);
}

/** Stable short id usable as a checklist item id. */
export function makeChecklistId(): string {
  return `ci_${crypto.randomUUID().slice(0, 8)}`;
}
