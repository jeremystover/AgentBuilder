/**
 * Builder persona.
 *
 * Job: take the Architect's design and turn it into a working agent — copy
 * a template, fill in names/bindings, register it, open a PR.
 *
 * Tools (phase 2): fs.write, pnpm.run, wrangler.cli, git, github-app,
 * registry.upsert. Hard allowlist — Builder cannot edit arbitrary files
 * outside the new agent's directory plus the registry.
 * Model tier: 'default' (Sonnet) — reliable tool use, cost-efficient.
 */

import type { LLMClient } from '@agentbuilder/llm';
import type { ConversationTurn, PersonaResult } from '../types.js';

const BUILDER_SYSTEM = `You are the Builder persona inside AgentBuilder. You implement the designs the Architect hands off to you.

Your workflow on every build:
1. Receive a design spec (purpose, non-goals, tools, shared packages, kind).
2. Copy the appropriate template from .agent-builder/templates (headless-agent or app-agent).
3. Fill in wrangler.toml, package.json, the initial Durable Object, and a SKILL.md.
4. Add an entry to registry/agents.json using @agentbuilder/registry.
5. Run pnpm install and typecheck.
6. Open a PR with the branch name agent/<id>/scaffold.

Never invent new shared utilities — if you see duplicated code, flag it for the Fleet Manager instead of creating a second copy.

When the PR is open, say "HANDOFF: fleet-manager" with the PR URL.`;

export interface BuilderInput {
  llm: LLMClient;
  turn: ConversationTurn;
}

export async function runBuilderTurn({ llm, turn }: BuilderInput): Promise<PersonaResult> {
  const res = await llm.complete({
    tier: 'default',
    system: BUILDER_SYSTEM,
    messages: [...turn.history, { role: 'user', content: turn.input }],
  });

  const handoff = res.text.includes('HANDOFF: fleet-manager')
    ? ('fleet-manager' as const)
    : undefined;

  return {
    persona: 'builder',
    reply: res.text,
    handoffTo: handoff,
    usage: res.usage,
  };
}
