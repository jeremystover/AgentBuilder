import type { R2Bucket } from "@cloudflare/workers-types";

const HTML_PREFIX   = "html";
const TEXT_PREFIX   = "text";
const CACHE_CONTROL = "private, max-age=31536000, immutable";

export function getHTMLKey(articleId: string): string {
  return `${HTML_PREFIX}/${articleId}.html`;
}

export function getTextKey(articleId: string): string {
  return `${TEXT_PREFIX}/${articleId}.txt`;
}

export async function storeHTML(bucket: R2Bucket, key: string, html: string): Promise<void> {
  await bucket.put(key, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8", cacheControl: CACHE_CONTROL },
  });
}

export async function storeText(bucket: R2Bucket, key: string, text: string): Promise<void> {
  await bucket.put(key, text, {
    httpMetadata: { contentType: "text/plain; charset=utf-8", cacheControl: CACHE_CONTROL },
  });
}

export async function getObject(bucket: R2Bucket, key: string): Promise<string | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return obj.text();
}

export async function deleteObject(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

export async function objectExists(bucket: R2Bucket, key: string): Promise<boolean> {
  const head = await bucket.head(key);
  return head !== null;
}
