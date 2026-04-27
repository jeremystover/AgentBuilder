/**
 * @agentbuilder/credential-vault
 *
 * Generic encrypted vault for opaque third-party credentials — cookies,
 * session JWTs, API keys, basic-auth blobs. Reads are scoped by agentId so
 * one agent cannot accidentally read another's secrets.
 *
 * For OAuth flows that require refresh-token logic, prefer a
 * provider-specific package (e.g. @agentbuilder/auth-google).
 */

export * from './types.js';
export * from './vault.js';
export * from './api.js';
export { CREDENTIAL_VAULT_SCHEMA } from './schema.js';
