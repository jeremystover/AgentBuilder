// Frontend types — mirror the backend's lab-api.ts shapes. Keep these
// in sync if you change the wire format.

export type IdeaStatus = "spark" | "developing" | "ready" | "promoted";

export interface PromotedTo {
  project_id: string;
  project_name: string;
  task_key?: string;
}

export interface Idea {
  id: string;
  title: string;
  body: string;
  status: IdeaStatus;
  tags: string[];
  linked_article_ids: string[];
  chat_thread: ChatTurn[];
  promoted_to: PromotedTo | null;
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
