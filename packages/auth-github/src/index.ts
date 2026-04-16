/**
 * @agentbuilder/auth-github
 *
 * Shared GitHub App client. The model:
 *   - ONE GitHub App installed on the org, reused by every agent
 *   - Installation tokens minted on demand per agent (scoped to the
 *     repositories that agent declares in its registry entry)
 *   - No per-user OAuth needed for fleet operations; user OAuth happens
 *     only for consumer-facing app agents that need it
 *
 * RS256 JWT signing + installation token minting against the GitHub API.
 */

export * from './types.js';
export * from './client.js';
export * from './jwt.js';
