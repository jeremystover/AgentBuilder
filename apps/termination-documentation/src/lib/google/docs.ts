/**
 * Google Docs v1 REST wrapper. Creates a document and rewrites its body
 * from a markdown string. Markdown is preserved verbatim — we do not try
 * to parse headings/bullets into Docs structural elements, which would
 * require a full CommonMark parser. A plain-text Doc with markdown
 * syntax is a clean handoff to counsel who can paste into Word / Pages
 * if they want different formatting.
 */

const DOCS_API = 'https://docs.googleapis.com/v1';

export interface GoogleDoc {
  documentId: string;
  title: string;
}

export async function createDoc(token: string, title: string): Promise<GoogleDoc> {
  const res = await fetch(`${DOCS_API}/documents`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(await docsError(res, 'createDoc'));
  const doc = (await res.json()) as { documentId: string; title: string };
  return doc;
}

/**
 * Replace the entire document body with the supplied markdown text.
 *
 * Uses batchUpdate with a deleteContentRange covering the whole body (if any)
 * followed by an insertText at index 1. Index 1 is the first valid insertion
 * point in a Google Doc.
 */
export async function setDocBody(
  token: string,
  documentId: string,
  markdown: string,
): Promise<void> {
  // First, fetch document metadata to know the end index.
  const getRes = await fetch(`${DOCS_API}/documents/${documentId}?fields=body`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!getRes.ok) throw new Error(await docsError(getRes, 'getDoc'));
  const doc = (await getRes.json()) as {
    body?: { content?: Array<{ endIndex?: number }> };
  };
  const contents = doc.body?.content ?? [];
  const endIndex =
    contents.length > 0 ? Math.max(1, (contents[contents.length - 1]?.endIndex ?? 1) - 1) : 1;

  const requests: Record<string, unknown>[] = [];
  if (endIndex > 1) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex },
      },
    });
  }
  requests.push({
    insertText: {
      location: { index: 1 },
      text: markdown,
    },
  });

  const res = await fetch(`${DOCS_API}/documents/${documentId}:batchUpdate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(await docsError(res, 'batchUpdate'));
}

export function docUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

async function docsError(res: Response, context: string): Promise<string> {
  let body: string;
  try {
    body = await res.text();
  } catch {
    body = '(unreadable body)';
  }
  return `Docs ${context} failed: HTTP ${res.status} — ${body.slice(0, 500)}`;
}
