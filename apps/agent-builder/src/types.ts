import type { ChatMessage, CompleteResponse } from '@agentbuilder/llm';

export type PersonaId = 'architect' | 'builder' | 'fleet-manager';

export interface ConversationTurn {
  persona: PersonaId;
  input: string;
  history: ChatMessage[];
}

export interface PersonaResult {
  persona: PersonaId;
  reply: string;
  /** Optional handoff: which persona should handle the next turn */
  handoffTo?: PersonaId;
  usage: CompleteResponse['usage'] & {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /**
   * Full message history after this turn, including any tool_use /
   * tool_result blocks the persona generated. The DO persists this so
   * subsequent turns pick up where the last one left off.
   */
  messages: ChatMessage[];
  /** How many LLM calls this turn consumed (tool loop iterations) */
  iterations: number;
}
