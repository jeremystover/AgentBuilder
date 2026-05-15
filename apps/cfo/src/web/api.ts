// Thin fetch wrapper. All endpoints sit under /api/web/*; the worker's
// requireApiAuth gate uses the cookie set by /login.

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) {
    let message = `${method} ${path} failed (${res.status})`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch { /* ignore */ }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get:   <T>(path: string) => request<T>("GET", path),
  post:  <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put:   <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del:   <T>(path: string) => request<T>("DELETE", path),
};

// ── Shared types (mirror backend payloads) ────────────────────────────────

export interface Entity {
  id: string;
  name: string;
  type: "personal" | "schedule_c" | "schedule_e";
  slug: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  entity_type: "personal" | "schedule_c" | "schedule_e" | "all";
  category_set: "schedule_c" | "schedule_e" | "budget" | "custom";
  description: string | null;
}

export interface AccountRow {
  id: string;
  name: string;
  institution: string | null;
  type: string;
  source: "teller" | "email" | "chrome_extension" | "manual";
  entity_id: string | null;
  is_active: boolean;
  last_synced_at: string | null;
}

export interface ReviewRow {
  id: string;
  date: string;
  amount: number;
  description: string;
  merchant: string | null;
  account_id: string | null;
  account_name: string | null;
  account_type: string | null;
  entity_id: string | null;
  category_id: string | null;
  category_slug: string | null;
  classification_method: "rule" | "ai" | "manual" | "historical" | null;
  ai_confidence: number | null;
  ai_notes: string | null;
  human_notes: string | null;
  is_transfer: boolean;
  is_reimbursable: boolean;
  expense_flag: "cut" | "one_time" | null;
  status: "staged" | "waiting";
  waiting_for: string | null;
  supplement_json: Record<string, unknown> | null;
}

export interface ReviewListResponse {
  rows: ReviewRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface TransactionRow {
  id: string;
  date: string;
  amount: number;
  description: string;
  merchant: string | null;
  account_id: string | null;
  account_name: string | null;
  account_type: string | null;
  entity_id: string | null;
  entity_name: string | null;
  category_id: string | null;
  category_name: string | null;
  category_slug: string | null;
  classification_method: string | null;
  ai_confidence: number | null;
  ai_notes: string | null;
  human_notes: string | null;
  is_transfer: boolean;
  is_reimbursable: boolean;
  status: "pending_review" | "approved" | "excluded";
  approved_at: string | null;
}

export interface TransactionListResponse {
  rows: TransactionRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface SnapshotResponse {
  pending_review_count: number;
  waiting_count: number;
  approved_30d_count: number;
  recent_syncs: Array<{
    source: string;
    started_at: string;
    completed_at: string | null;
    status: string;
    transactions_new: number;
  }>;
  email_sync: Array<{
    vendor: string;
    last_processed_at: string | null;
    unresolved_failures: number;
  }>;
}

export interface RuleRow {
  id: string;
  name: string;
  match_json: Record<string, unknown>;
  entity_id: string | null;
  category_id: string | null;
  is_active: boolean;
  match_count: number;
}

export interface GatherStatus {
  teller: {
    enrollments: Array<{
      enrollment_id: string;
      institution_name: string | null;
      last_synced_at: string | null;
      account_count: number;
    }>;
    connect_config: {
      application_id: string;
      environment: string;
      products: string[];
      select_account: string;
    } | null;
  };
  email: SnapshotResponse["email_sync"];
  recent_log: Array<{
    id: string;
    source: string;
    started_at: string;
    completed_at: string | null;
    status: string;
    transactions_found: number;
    transactions_new: number;
    error_message: string | null;
  }>;
}
