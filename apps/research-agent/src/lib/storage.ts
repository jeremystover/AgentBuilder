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

// ── Attachment storage ────────────────────────────────────────

const ATTACHMENT_PREFIX = "attachments";

export function getAttachmentKey(attachmentId: string, filename: string): string {
  return `${ATTACHMENT_PREFIX}/${attachmentId}/${filename}`;
}

export async function storeAttachment(
  bucket: R2Bucket,
  key: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<void> {
  await bucket.put(key, data, {
    httpMetadata: { contentType, cacheControl: CACHE_CONTROL },
  });
}

export async function listR2Keys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const obj of result.objects) {
      keys.push(obj.key);
    }
    if (!result.truncated) break;
    cursor = result.cursor;
  }
  return keys;
}
