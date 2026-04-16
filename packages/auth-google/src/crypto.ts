/**
 * Authenticated encryption (AES-GCM) for sensitive token storage.
 *
 * Tokens are encrypted at rest in the database using AES-256-GCM with a
 * Key Encryption Key (KEK) stored in Cloudflare Secrets.
 *
 * Format: base64(IV + ciphertext + authTag) where each component is raw bytes.
 * IV is randomly generated per encryption operation (96 bits, per NIST SP 800-38D).
 */

const ALGORITHM = 'AES-GCM';
const KEY_SIZE = 256; // bits
const IV_SIZE = 12; // bytes (96 bits, recommended for GCM)
const TAG_SIZE = 16; // bytes (128 bits)

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns base64-encoded (IV + ciphertext + authTag).
 */
export async function encryptToken(plaintext: string, kek: CryptoKey): Promise<string> {
  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(IV_SIZE));

  // Encrypt
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    kek,
    new TextEncoder().encode(plaintext),
  );

  // Concatenate IV + ciphertext (authTag is included in ciphertext with GCM)
  const encrypted = new Uint8Array(iv.length + ciphertext.byteLength);
  encrypted.set(iv, 0);
  encrypted.set(new Uint8Array(ciphertext), iv.length);

  // Encode as base64
  return btoa(String.fromCharCode(...encrypted));
}

/**
 * Decrypt an AES-256-GCM ciphertext.
 * Expects base64-encoded (IV + ciphertext + authTag).
 */
export async function decryptToken(encrypted: string, kek: CryptoKey): Promise<string> {
  try {
    // Decode from base64
    const bytes = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

    // Extract IV and ciphertext
    const iv = bytes.slice(0, IV_SIZE);
    const ciphertext = bytes.slice(IV_SIZE);

    // Decrypt
    const plaintext = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv },
      kek,
      ciphertext,
    );

    return new TextDecoder().decode(plaintext);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Token decryption failed: ${message}`);
  }
}

/**
 * Import a raw 256-bit key material (32 bytes) as an AES-GCM CryptoKey.
 * Typically used to import a KEK from Cloudflare Secrets Store.
 */
export async function importKey(keyMaterial: ArrayBuffer): Promise<CryptoKey> {
  if (keyMaterial.byteLength !== 32) {
    throw new Error(`AES-GCM key must be exactly 32 bytes, got ${keyMaterial.byteLength}`);
  }

  return crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: ALGORITHM, length: KEY_SIZE },
    false, // not extractable
    ['encrypt', 'decrypt'],
  );
}

/**
 * Generate a new random AES-256 key. Used for development and key rotation.
 */
export async function generateKey(): Promise<CryptoKey> {
  const key = await crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_SIZE },
    true, // extractable (for export to Secrets Store)
    ['encrypt', 'decrypt'],
  );
  // For symmetric keys, generateKey returns CryptoKey directly, not CryptoKeyPair
  return key as CryptoKey;
}

/**
 * Export a CryptoKey to raw bytes for storage in Cloudflare Secrets.
 */
export async function exportKey(key: CryptoKey): Promise<ArrayBuffer> {
  const exported = await crypto.subtle.exportKey('raw', key);
  // exportKey with 'raw' format always returns ArrayBuffer
  return exported as ArrayBuffer;
}
