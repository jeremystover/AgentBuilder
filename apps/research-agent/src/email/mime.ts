/**
 * Minimal MIME parser sufficient for newsletter ingestion.
 *
 * Handles:
 *   - top-level multipart/alternative and multipart/mixed
 *   - text/plain and text/html parts
 *   - quoted-printable and base64 transfer encodings
 *   - charset=utf-8 / us-ascii (anything else falls back to UTF-8 best-effort)
 *
 * Skips: nested multipart depth > 2, attachments, signed messages.
 */

export interface ParsedMime {
  /** Decoded text/plain if present, else text/html stripped to plain text. */
  textBody: string;
  /** Decoded text/html if present, else null. */
  htmlBody: string | null;
}

export function parseMime(raw: string): ParsedMime {
  const { headers, body } = splitHeadersAndBody(raw);
  const contentType = headers.get('content-type') ?? 'text/plain';
  const transferEncoding = headers.get('content-transfer-encoding') ?? '7bit';

  const parts = collectParts(contentType, transferEncoding, body, 0);
  const textPart = parts.find((p) => p.contentType.startsWith('text/plain'));
  const htmlPart = parts.find((p) => p.contentType.startsWith('text/html'));

  const textBody = textPart
    ? textPart.body
    : htmlPart
      ? stripHtml(htmlPart.body)
      : '';

  return { textBody, htmlBody: htmlPart?.body ?? null };
}

interface PartialPart {
  contentType: string;
  body: string;
}

function collectParts(
  contentType: string,
  transferEncoding: string,
  body: string,
  depth: number,
): PartialPart[] {
  const ctLower = contentType.toLowerCase();
  if (ctLower.startsWith('multipart/') && depth < 3) {
    const boundary = extractParam(contentType, 'boundary');
    if (!boundary) return [];
    const parts = splitMultipart(body, boundary);
    return parts.flatMap((part) => {
      const { headers: ph, body: pb } = splitHeadersAndBody(part);
      const innerCt = ph.get('content-type') ?? 'text/plain';
      const innerTe = ph.get('content-transfer-encoding') ?? '7bit';
      return collectParts(innerCt, innerTe, pb, depth + 1);
    });
  }
  return [{ contentType: ctLower, body: decodeBody(body, transferEncoding) }];
}

function splitHeadersAndBody(raw: string): { headers: Map<string, string>; body: string } {
  const normalised = raw.replace(/\r\n/g, '\n');
  const sep = normalised.indexOf('\n\n');
  const headerBlock = sep === -1 ? normalised : normalised.slice(0, sep);
  const body = sep === -1 ? '' : normalised.slice(sep + 2);
  return { headers: parseHeaders(headerBlock), body };
}

function parseHeaders(block: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = block.split('\n');
  let current: { name: string; value: string } | null = null;
  for (const line of lines) {
    if (/^\s/.test(line) && current) {
      current.value += ` ${line.trim()}`;
      continue;
    }
    if (current) map.set(current.name.toLowerCase(), current.value.trim());
    const colon = line.indexOf(':');
    if (colon === -1) {
      current = null;
      continue;
    }
    current = { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  }
  if (current) map.set(current.name.toLowerCase(), current.value.trim());
  return map;
}

function extractParam(headerValue: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|([^;\\s]+))`, 'i');
  const m = re.exec(headerValue);
  return m ? (m[2] ?? m[3] ?? null) : null;
}

function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const segments = body.split(marker);
  // First segment is preamble; last is `--\n…` epilogue.
  return segments.slice(1, -1).map((s) => s.replace(/^\n/, '').replace(/\n$/, ''));
}

function decodeBody(body: string, transferEncoding: string): string {
  const enc = transferEncoding.toLowerCase();
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  if (enc === 'base64') return decodeBase64(body);
  return body;
}

function decodeQuotedPrintable(input: string): string {
  // Soft line breaks: =\n
  const joined = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === '=' && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push((ch ?? '').charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeBase64(input: string): string {
  const cleaned = input.replace(/\s+/g, '');
  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return input;
  }
}

const SCRIPT_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;
const ENTITY_RE = /&(amp|lt|gt|quot|#39|nbsp);/g;
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ',
};

export function stripHtml(html: string): string {
  return html
    .replace(SCRIPT_STYLE_RE, '')
    .replace(/<\/(p|div|br|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(TAG_RE, '')
    .replace(ENTITY_RE, (_m, e) => ENTITIES[e] ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Decode RFC-2047 encoded-word headers (=?charset?B?...?= or =?charset?Q?...?=). */
export function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _charset, enc, payload) => {
    if (enc.toLowerCase() === 'b') return decodeBase64(payload);
    return decodeQuotedPrintable(payload.replace(/_/g, ' '));
  });
}

export function parseAddress(headerValue: string): { name: string | null; address: string } {
  const trimmed = decodeHeader(headerValue).trim();
  const angle = /^(.*)<([^>]+)>\s*$/.exec(trimmed);
  if (angle) {
    const name = (angle[1] ?? '').trim().replace(/^"(.*)"$/, '$1') || null;
    return { name, address: (angle[2] ?? '').trim().toLowerCase() };
  }
  return { name: null, address: trimmed.toLowerCase() };
}
