/**
 * @agentbuilder/registry
 *
 * The registry is the fleet's single source of truth: one JSON file per
 * environment describing every agent — its purpose, non-goals, routing
 * hints, tools, Cloudflare bindings, and shared packages. AgentBuilder
 * reads it to decide whether a new agent is needed vs. extending an
 * existing one, and to flag overlaps.
 *
 * The default entry point is Worker-safe (no node:fs). Node callers that
 * need the file-backed store should import `@agentbuilder/registry/node`.
 */

export * from './schema.js';
export * from './reader.js';
export * from './memory-store.js';
