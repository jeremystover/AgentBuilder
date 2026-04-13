// Thin wrappers around Web Crypto HMAC-SHA256, used by webhook
// verification for Stripe (hex) and Square (base64).  Works in the
// Cloudflare Workers runtime - no Node dependencies.

export async function hmacSha256Raw(key: string, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

export async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const buf = await hmacSha256Raw(key, data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Base64(key: string, data: string): Promise<string> {
  const buf = await hmacSha256Raw(key, data);
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
