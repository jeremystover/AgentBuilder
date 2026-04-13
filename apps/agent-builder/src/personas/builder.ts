/**
 * Builder persona — phase 2 stub.
 *
 * Job: take the Architect's design and turn it into a working agent — copy
 * a template, fill in names/bindings, register it, open a PR.
 *
 * Phase 2 leaves this as a single-turn stub so the Architect can be tested
 * in isolation. Phase 3 replaces the body with a full tool loop that has
 * fs.write, pnpm, wrangler, git, github-app, and registry-upsert tools.
 */

import type { ChatMessage, LLMClient } from '@agentbuilder/llm';
import type { PersonaResult } from '../types.js';

const BUILDER_SYSTEM = `You are the Builder persona inside AgentBuilder. Phase 3 will give you real tools. For now, acknowledge what the Architect handed off and describe the scaffolding you would do — but do not attempt to execute anything.`;

export interface BuilderInput {
  llm: LLMClient;
  history: ChatMessage[];
  userMessage: string;
}

export async function runBuilderTurn(input: BuilderInput): Promise<PersonaResult> {
  const res = await input.llm.complete({
    tier: 'default',
    system: BUILDER_SYSTEM,
    messages: [...input.history, { role: 'user', content: input.userMessage }],
  });

  return {
    persona: 'builder',
    reply: res.text,
    usage: res.usage,
    messages: [
      ...input.history,
      { role: 'user', content: input.userMessage },
      { role: 'assistant', content: res.text },
    ],
    iterations: 1,
  };
}
