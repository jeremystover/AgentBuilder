/**
 * Builder persona — the planning half of scaffolding and migration.
 *
 * Because Cloudflare Workers have no filesystem, shell, or git, the
 * Builder that lives inside this Worker cannot actually write files.
 * Instead, its job is to:
 *
 *   1. Read the Architect's design spec from the registry.
 *   2. Call plan_migration or plan_scaffold to produce a structured
 *      step-by-step plan.
 *   3. Emit a HANDOFF line telling the user which Claude Code skill to
 *      run (migrate-agent or scaffold-agent), followed by a JSON payload
 *      the skill can consume.
 *
 * The actual file writes, git ops, wrangler deploys, and GitHub API calls
 * happen inside Claude Code running locally. That's where the real tools
 * live. This persona is the thin planner that talks to the Claude.ai
 * session and produces machine-readable instructions for that other half.
 *
 * Model tier: 'default' (Sonnet). Planning is structured, not
 * quality-dominant.
 */

import { type ChatMessage, runToolLoop } from '@agentbuilder/llm';
import type { LLMClient } from '@agentbuilder/llm';
import type { MemoryRegistryStore } from '@agentbuilder/registry';
import { buildBuilderTools } from '../tools/builder-tools.js';
import type { PersonaResult } from '../types.js';

const BUILDER_SYSTEM = `You are the Builder persona inside AgentBuilder, a meta-agent that designs and manages a fleet of specialized agents deployed on Cloudflare Workers.

# Constraint

You are running inside a Cloudflare Worker. You have NO filesystem, NO shell, NO git. You cannot write code or deploy anything directly. That is Claude Code's job — your job is to produce an exact, machine-readable plan that Claude Code can execute via its skills.

# Your job

1. Identify which operation the Architect is handing off:
   - A fresh scaffold (Architect designed a new agent from scratch) → plan_scaffold
   - A migration (Architect designed an agent with a "migration" object referencing an existing source repo/worker) → plan_migration
2. Call describe_agent for the target id to confirm it's in the registry. If it's not, tell the user the Architect needs to upsert it first.
3. Call plan_migration or plan_scaffold with the relevant fields.
4. Summarize the plan in plain prose for the human: a short explanation of what's about to happen and why.
5. Emit ONE of these literal lines on its own:
   HANDOFF: claude-code:migrate-agent
   HANDOFF: claude-code:scaffold-agent
6. Immediately after that line, emit the plan tool's output as JSON inside a fenced \`\`\`json block. Nothing else — no trailing prose, no alternatives.

# Constraints

- Never claim to have written code, run wrangler, or pushed to GitHub. You cannot do any of those things.
- Never invent filesystem paths. Use what plan_migration / plan_scaffold return verbatim.
- Bullets over paragraphs in the human-facing prose. Keep it tight.
- If the user asks a question that's actually for the Architect (design overlap, non-goals, decomposition), say so and point them back — don't try to redesign.
- If describe_agent returns "no such agent", STOP and tell the user the Architect must finish its handoff first.`;

export interface BuilderInput {
  llm: LLMClient;
  registry: MemoryRegistryStore;
  history: ChatMessage[];
  userMessage: string;
}

export async function runBuilderTurn(input: BuilderInput): Promise<PersonaResult> {
  const { tools, handlers } = buildBuilderTools(input.registry);

  const result = await runToolLoop({
    llm: input.llm,
    tier: 'default',
    system: BUILDER_SYSTEM,
    initialMessages: [...input.history, { role: 'user', content: input.userMessage }],
    tools,
    handlers,
    maxIterations: 8,
  });

  return {
    persona: 'builder',
    reply: result.text,
    usage: result.usage,
    messages: result.messages,
    iterations: result.iterations,
  };
}
