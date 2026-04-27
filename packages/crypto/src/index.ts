/**
 * @agentbuilder/crypto
 *
 * Shared cryptographic primitives. Currently provides authenticated
 * encryption (AES-256-GCM) used by `@agentbuilder/auth-google` and
 * `@agentbuilder/credential-vault` for at-rest secrets.
 */

export * from './aes.js';
