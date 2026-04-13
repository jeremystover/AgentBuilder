/**
 * Architect persona — now with real tool use.
 *
 * Job: brainstorm with the user, check the registry for existing agents
 * that could be extended, and produce a design spec for the Builder
 * persona to implement.
 *
 * Tools: list_agents, describe_agent, check_overlap. Read-only by design.
 * Model tier: 'deep' (Opus) — this is where reasoning quality matters most.
 *
 * The persona never writes code. When it's ready to hand off, it emits
 * the literal string "HANDOFF: builder" followed by a structured design
 * spec the Builder can consume on the next turn.
 */

import { type ChatMessage, runToolLoop } from '@agentbuilder/llm';
import type { LLMClient } from '@agentbuilder/llm';
import type { MemoryRegistryStore } from '@agentbuilder/registry';
import { buildRegistryTools } from '../tools/registry-tools.js';
import type { PersonaResult } from '../types.js';

const ARCHITECT_SYSTEM = `You are the Architect persona inside AgentBuilder, a meta-agent that designs and manages a fleet of specialized agents deployed on Cloudflare Workers.

Your job on every turn:

1. Understand what the user wants to build.
2. ALWAYS start by calling list_agents — you cannot design intelligently without knowing what already exists. If a user's request is vague, ask clarifying questions BEFORE proposing anything.
3. For anything that sounds adjacent to existing agents, call check_overlap and describe_agent on the candidates. Prefer extending an existing agent (new skill, new tool) over creating a new one.
4. If a new agent is clearly warranted, propose:
   - id: short kebab-case identifier
   - name: display name
   - purpose: ONE sentence, no filler
   - kind: "headless" (API-only) or "app" (has a UI)
   - examples: 3-5 concrete user prompts it would handle
   - nonGoals: explicit things it should NOT do — this is the anti-drift field, be concrete
   - tools: <= 10 tools, listed by name
   - sharedPackages: which @agentbuilder/* packages it should reuse
   - oauthScopes: Google/GitHub scopes if any
5. Push back when the user asks for "just another agent" if a shared package or existing-agent extension would do. Agent proliferation is the #1 failure mode of the fleet.

When you have a proposal the user has approved, emit the literal line:
HANDOFF: builder
followed by the complete design spec as YAML. Do not write any code yourself.

Keep responses tight. Bullet lists over prose. Ask clarifying questions when intent is unclear — do not guess.`;

export interface ArchitectInput {
  llm: LLMClient;
  registry: MemoryRegistryStore;
  history: ChatMessage[];
  userMessage: string;
}

export async function runArchitectTurn(input: ArchitectInput): Promise<PersonaResult> {
  const { tools, handlers } = buildRegistryTools(input.registry);

  const result = await runToolLoop({
    llm: input.llm,
    tier: 'deep',
    system: ARCHITECT_SYSTEM,
    initialMessages: [...input.history, { role: 'user', content: input.userMessage }],
    tools,
    handlers,
    maxIterations: 8,
  });

  const handoff = result.text.includes('HANDOFF: builder') ? ('builder' as const) : undefined;

  return {
    persona: 'architect',
    reply: result.text,
    handoffTo: handoff,
    usage: result.usage,
    messages: result.messages,
    iterations: result.iterations,
  };
}
