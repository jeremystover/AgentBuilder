/**
 * Token-shaped re-exports of the shared AES-256-GCM helpers in
 * `@agentbuilder/crypto`. These names are kept for backward compatibility
 * with the original auth-google API.
 */

import { decrypt, encrypt } from '@agentbuilder/crypto';

export { exportKey, generateKey, importKey } from '@agentbuilder/crypto';

export async function encryptToken(plaintext: string, kek: CryptoKey): Promise<string> {
  return encrypt(plaintext, kek);
}

export async function decryptToken(ciphertext: string, kek: CryptoKey): Promise<string> {
  return decrypt(ciphertext, kek);
}
