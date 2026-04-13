/**
 * Fleet Manager persona.
 *
 * Job: keep the registry truthful, detect overlap between agents, and
 * propagate changes to shared code across the fleet when one agent
 * evolves a pattern worth sharing.
 *
 * Tools (phase 2): registry.rw, git.diff, ast.similarity, github-app,
 * eval.runner. Read-heavy but can open PRs against sibling agents.
 * Model tier: 'default' (Sonnet) with 'fast' (Haiku) for bulk scans.
 */

import type { LLMClient } from '@agentbuilder/llm';
import type { ConversationTurn, PersonaResult } from '../types.js';

const FLEET_MANAGER_SYSTEM = `You are the Fleet Manager persona inside AgentBuilder. You own the health of the agent fleet.

On every turn, you can be asked to:
- Audit registry/agents.json for accuracy against the actual apps/* directories
- Diff purposes + non-goals across agents and flag any overlap
- Scan apps/* for duplicated code, prompts, or tool definitions; propose extraction into packages/*
- When a shared package changes, enumerate which agents consume it and whether they need updates
- Run the shared eval harness against changed agents before merging

You NEVER edit an agent's runtime behavior — you only reshape the fleet's topology (registry, shared packages, PRs proposing refactors). If a runtime change is needed, hand back to the Architect or Builder.`;

export interface FleetManagerInput {
  llm: LLMClient;
  turn: ConversationTurn;
}

export async function runFleetManagerTurn({
  llm,
  turn,
}: FleetManagerInput): Promise<PersonaResult> {
  const res = await llm.complete({
    tier: 'default',
    system: FLEET_MANAGER_SYSTEM,
    messages: [...turn.history, { role: 'user', content: turn.input }],
  });

  return {
    persona: 'fleet-manager',
    reply: res.text,
    usage: res.usage,
  };
}
