import type { ModelTier } from './models.js';

/**
 * Content blocks. Messages can hold structured content when tool use is
 * involved — this lets us reconstruct the conversation on subsequent turns
 * without losing tool_use ids.
 */

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  /**
   * Plain text for simple turns, or an array of blocks when tool use is
   * involved. The `role` determines which block types are valid:
   *   - 'user'      can have text + tool_result blocks
   *   - 'assistant' can have text + tool_use blocks
   */
  content: string | ContentBlock[];
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
