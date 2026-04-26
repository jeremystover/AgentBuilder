// Frontend types — mirror the backend's lab-api.ts shapes. Keep these
// in sync if you change the wire format.

export type IdeaStatus = "spark" | "developing" | "ready" | "promoted";

export interface PromotedTo {
  project_id: string;
  project_name: string;
  task_key?: string;
}

export interface IdeaPosition { x: number; y: number }

export interface Idea {
  id: string;
  title: string;
  body: string;
  status: IdeaStatus;
  tags: string[];
  linked_article_ids: string[];
  chat_thread: ChatTurn[];
  promoted_to: PromotedTo | null;
  /** User-arranged mind-map coordinates; null when auto-laid-out. */
  position: IdeaPosition | null;
  created_at: string;
  updated_at: string;
}

export interface Article {
  id: string;
  title: string | null;
  url: string;
  summary: string | null;
  source_id: string | null;
  topics: string[];
  ingested_at: string;
}

export interface Project {
  projectId: string;
  name: string;
  status?: string;
  healthStatus?: string;
  goalId?: string;
}

export type ChatScope = "selected" | "digest" | "full_corpus";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

// Anthropic-style message used in /api/lab/chat history. The backend
// echoes the structured content back when tool calls happened — but the
// frontend only renders the text turns.
export interface ChatMessage {
  role: "user" | "assistant";
  content: unknown;
}

export type ArticleWindow = "7d" | "30d" | "all";

// ── Chat sessions ────────────────────────────────────────────────────────

export interface ChatSession {
  id: string;
  title: string;
  tags: string[];
  notes: string;
  scope: ChatScope;
  pinned_article_ids: string[];
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
}

/** Persisted message row as returned by GET /api/lab/sessions/:id. */
export interface PersistedMessage {
  id: string;
  role: "user" | "assistant";
  /**
   * Anthropic-shaped content — string for plain turns, ContentBlock[] when
   * tool_use/tool_result blocks are present. The chat hook re-renders only
   * the text from these (tool blocks are status pills already lost on
   * refresh — that's an acceptable tradeoff for V1).
   */
  content: unknown;
  created_at: string;
}

// ── Notes ────────────────────────────────────────────────────────────────

export type NoteTargetKind = "idea" | "article";

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  /** null when the note is standalone (not attached to an idea/article). */
  target_kind: NoteTargetKind | null;
  target_id: string | null;
  /** Set when the note was created via "Save as note" from a chat reply. */
  source_session_id: string | null;
  linked_article_ids: string[];
  created_at: string;
  updated_at: string;
}
