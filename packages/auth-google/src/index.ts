/**
 * @agentbuilder/auth-google
 *
 * Shared Google OAuth client + token vault. The model is:
 *   - ONE OAuth client registered in Google Cloud, reused by every agent
 *   - Per-(agent, user) tokens stored in D1, encrypted at rest with AES-256-GCM
 *   - Token retrieval ALWAYS scoped by agentId — prevents cross-agent leaks
 *
 * Includes crypto utilities for key management and authenticated token encryption.
 */

export * from './types.js';
export * from './vault.js';
export * from './crypto.js';
export { GOOGLE_TOKEN_VAULT_SCHEMA } from './schema.js';
