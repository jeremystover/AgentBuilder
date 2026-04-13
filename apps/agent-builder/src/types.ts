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
  usage: CompleteResponse['usage'];
}
