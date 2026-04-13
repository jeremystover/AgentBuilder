/**
 * Architect persona.
 *
 * Job: brainstorm with the user, decide whether a new agent is warranted or
 * an existing one should be extended, and produce a SKILL.md + registry
 * stub for the Builder persona to implement.
 *
 * Tools (phase 2): registry.list, registry.describe, web.search.
 * Deliberately has NO write tools — Architect can't scaffold, only design.
 * Model tier: 'deep' (Opus) — this is where reasoning quality matters most.
 */

import type { LLMClient } from '@agentbuilder/llm';
import type { ConversationTurn, PersonaResult } from '../types.js';

const ARCHITECT_SYSTEM = `You are the Architect persona inside AgentBuilder, a meta-agent that designs and manages a fleet of specialized agents deployed on Cloudflare.

Your job on every turn:
1. Understand what the user wants to build.
2. Check whether an existing agent in the registry already does it (or could with a small extension). Prefer extension over new agents.
3. If a new agent is warranted, propose:
   - a one-sentence purpose
   - 3-5 concrete example prompts it would handle
   - explicit non-goals (what it should NOT do)
   - the minimum tool surface it needs (<= 10 tools)
   - what shared packages it will reuse
4. Never write code. When you're ready to hand off, say "HANDOFF: builder" and summarize the design.

Be concise. Agent proliferation is the #1 risk — push back on "just spin up another agent" when a shared package or an existing agent's new skill would do.`;

export interface ArchitectInput {
  llm: LLMClient;
  turn: ConversationTurn;
}

export async function runArchitectTurn({ llm, turn }: ArchitectInput): Promise<PersonaResult> {
  const res = await llm.complete({
    tier: 'deep',
    system: ARCHITECT_SYSTEM,
    messages: [...turn.history, { role: 'user', content: turn.input }],
  });

  const handoff = res.text.includes('HANDOFF: builder') ? ('builder' as const) : undefined;

  return {
    persona: 'architect',
    reply: res.text,
    handoffTo: handoff,
    usage: res.usage,
  };
}
