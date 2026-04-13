/**
 * @agentbuilder/registry
 *
 * The registry is the fleet's single source of truth: one JSON file per
 * environment describing every agent — its purpose, non-goals, routing
 * hints, tools, Cloudflare bindings, and shared packages. AgentBuilder
 * reads it to decide whether a new agent is needed vs. extending an
 * existing one, and to flag overlaps.
 *
 * Kept as plain JSON so it's reviewable in PRs and diffable by humans.
 */

export * from './schema.js';
export * from './reader.js';
