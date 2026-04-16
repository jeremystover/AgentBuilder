/**
 * RS256 JWT signing for GitHub App authentication.
 *
 * GitHub App authentication uses RS256 (RSASSA-PKCS1-v1_5 with SHA-256) to sign
 * JWTs with the app's private key. The JWT is then exchanged for an installation
 * token scoped to specific repositories.
 *
 * Reference: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */

/**
 * Convert PEM-encoded PKCS#8 private key to CryptoKey suitable for signing.
 */
export async function importPrivateKey(pemKey: string): Promise<CryptoKey> {
  // Remove PEM headers/footers and whitespace
  const binaryString = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');

  // Convert base64 to ArrayBuffer
  const binaryData = Uint8Array.from(atob(binaryString), (c) => c.charCodeAt(0));

  // Import as PKCS#8
  return crypto.subtle.importKey(
    'pkcs8',
    binaryData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, // not extractable
    ['sign'],
  );
}

/**
 * Create and sign a GitHub App JWT.
 *
 * JWT payload includes:
 * - iss (issuer): GitHub App ID
 * - iat (issued at): current unix timestamp
 * - exp (expiration): iat + 10 minutes (GitHub only accepts 10 min JWTs)
 */
export async function signGitHubAppJwt(
  appId: string,
  privateKey: CryptoKey,
  nowMs?: number,
): Promise<string> {
  const nowS = Math.floor((nowMs ?? Date.now()) / 1000);
  const expS = nowS + 600; // 10 minutes, per GitHub limits

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const payload = {
    iss: appId,
    iat: nowS,
    exp: expS,
  };

  // Encode header and payload as base64url
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // Sign with RS256
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput),
  );

  const encodedSignature = base64url(signature);
  return `${signingInput}.${encodedSignature}`;
}

/**
 * Encode an ArrayBuffer or string to base64url (RFC 4648 Section 5).
 */
function base64url(data: ArrayBuffer | string): string {
  let bytes: Uint8Array;
  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data);
  } else {
    bytes = new Uint8Array(data);
  }

  // Standard base64 encoding
  const base64 = btoa(String.fromCharCode(...bytes));

  // Convert to base64url: replace +, /, and trim padding
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
