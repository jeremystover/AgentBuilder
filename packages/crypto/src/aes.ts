/**
 * Authenticated encryption (AES-256-GCM) for sensitive data at rest.
 *
 * Format: base64(IV || ciphertext || authTag) where each component is raw
 * bytes. IV is randomly generated per operation (96 bits, per NIST SP
 * 800-38D); GCM appends the 128-bit auth tag to the ciphertext automatically.
 */

const ALGORITHM = 'AES-GCM';
const KEY_SIZE = 256;
const IV_SIZE = 12;

export async function encrypt(plaintext: string, kek: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_SIZE));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    kek,
    new TextEncoder().encode(plaintext),
  );
  const out = new Uint8Array(iv.length + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...out));
}

export async function decrypt(encrypted: string, kek: CryptoKey): Promise<string> {
  try {
    const bytes = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    const iv = bytes.slice(0, IV_SIZE);
    const ciphertext = bytes.slice(IV_SIZE);
    const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, kek, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`AES-GCM decryption failed: ${message}`);
  }
}

export async function importKey(keyMaterial: ArrayBuffer): Promise<CryptoKey> {
  if (keyMaterial.byteLength !== 32) {
    throw new Error(`AES-GCM key must be exactly 32 bytes, got ${keyMaterial.byteLength}`);
  }
  return crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: ALGORITHM, length: KEY_SIZE },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function generateKey(): Promise<CryptoKey> {
  const key = await crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_SIZE },
    true,
    ['encrypt', 'decrypt'],
  );
  return key as CryptoKey;
}

export async function exportKey(key: CryptoKey): Promise<ArrayBuffer> {
  const exported = await crypto.subtle.exportKey('raw', key);
  return exported as ArrayBuffer;
}
