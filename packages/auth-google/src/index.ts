/**
 * @agentbuilder/auth-google
 *
 * Shared Google OAuth client + token vault. The model is:
 *   - ONE OAuth client registered in Google Cloud, reused by every agent
 *   - Per-(agent, user) tokens stored in D1, encrypted at rest
 *   - Token retrieval ALWAYS scoped by agentId — prevents cross-agent leaks
 *
 * Day-1 scope: interfaces + D1 schema + a scaffolded TokenVault. The actual
 * OAuth dance (auth url, callback, refresh) lands in the next phase.
 */

export * from './types.js';
export * from './vault.js';
export { GOOGLE_TOKEN_VAULT_SCHEMA } from './schema.js';
