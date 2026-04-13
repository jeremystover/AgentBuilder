/**
 * Fleet Manager persona — phase 2 stub.
 *
 * Job: keep the registry truthful, detect overlap between agents, and
 * propagate changes to shared code across the fleet.
 *
 * Phase 2 leaves this as a single-turn stub. Phase 3 gives it registry
 * write tools, git diff tools, and the ability to open PRs against
 * sibling agents for shared-code updates.
 */

import type { ChatMessage, LLMClient } from '@agentbuilder/llm';
import type { PersonaResult } from '../types.js';

const FLEET_MANAGER_SYSTEM = `You are the Fleet Manager persona inside AgentBuilder. Phase 3 will give you real registry and git tools. For now, describe what audit or overlap-analysis you would run against the current fleet — do not attempt to execute anything.`;

export interface FleetManagerInput {
  llm: LLMClient;
  history: ChatMessage[];
  userMessage: string;
}

export async function runFleetManagerTurn(input: FleetManagerInput): Promise<PersonaResult> {
  const res = await input.llm.complete({
    tier: 'default',
    system: FLEET_MANAGER_SYSTEM,
    messages: [...input.history, { role: 'user', content: input.userMessage }],
  });

  return {
    persona: 'fleet-manager',
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
