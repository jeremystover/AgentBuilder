import type { ModelTier } from './models.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object describing the tool input */
  inputSchema: Record<string, unknown>;
}

export interface CompleteRequest {
  tier: ModelTier;
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Override the tier's default output ceiling */
  maxOutputTokens?: number;
  /** Cache the system prompt across calls. On by default. */
  cacheSystemPrompt?: boolean;
}

export interface CompleteResponse {
  /** Concatenated text blocks from the assistant turn */
  text: string;
  /** Any tool-use calls the model emitted, in order */
  toolCalls: ToolCall[];
  /** Provider-reported token usage (best effort across providers) */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** 'end_turn' | 'tool_use' | 'max_tokens' | ... */
  stopReason: string;
  model: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
