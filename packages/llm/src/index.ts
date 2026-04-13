/**
 * @agentbuilder/llm
 *
 * Single entry point every agent uses to talk to LLMs. Callers pick a
 * semantic *tier* ('fast' | 'default' | 'deep' | 'edge') rather than a
 * concrete model id — that way we can re-balance cost/quality globally
 * without touching every agent.
 *
 * Day-1 surface is intentionally small: one `complete()` call that handles
 * both plain prompts and tool-use loops, plus prompt caching enabled by
 * default for the system prompt (huge cost savings on agent workloads).
 */

export * from './models.js';
export * from './client.js';
export * from './types.js';
export * from './tool-loop.js';
