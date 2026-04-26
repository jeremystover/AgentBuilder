/**
 * Thin Google Drive v3 REST wrapper. No SDK — the googleapis package is
 * too heavy for Workers. Every call takes an access token.
 *
 * Only the methods we need: create folder, upload file (multipart), share.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  webViewLink?: string;
}

export async function createFolder(
  token: string,
  name: string,
  parentId?: string,
): Promise<DriveFile> {
  const body: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) body.parents = [parentId];

  const res = await fetch(`${DRIVE_API}/files?fields=id,name,mimeType,webViewLink`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await driveError(res, 'createFolder'));
  return (await res.json()) as DriveFile;
}

export interface UploadOpts {
  fileName: string;
  mimeType: string;
  parentId: string;
  /** Raw bytes. */
  content: Uint8Array;
}

export async function uploadFile(token: string, opts: UploadOpts): Promise<DriveFile> {
  const metadata = {
    name: opts.fileName,
    parents: [opts.parentId],
  };

  // Multipart upload per Drive v3 spec:
  // https://developers.google.com/drive/api/guides/manage-uploads#multipart
  const boundary = `-------td-${crypto.randomUUID()}`;
  const enc = new TextEncoder();
  const delim = enc.encode(`\r\n--${boundary}\r\n`);
  const closeDelim = enc.encode(`\r\n--${boundary}--`);

  const metaPart = enc.encode(
    `Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`,
  );
  const filePartHeader = enc.encode(
    `Content-Type: ${opts.mimeType}\r\nContent-Transfer-Encoding: binary\r\n\r\n`,
  );

  const totalLen =
    delim.length +
    metaPart.length +
    delim.length +
    filePartHeader.length +
    opts.content.length +
    closeDelim.length;
  const body = new Uint8Array(totalLen);
  let offset = 0;
  const write = (chunk: Uint8Array) => {
    body.set(chunk, offset);
    offset += chunk.length;
  };
  write(delim);
  write(metaPart);
  write(delim);
  write(filePartHeader);
  write(opts.content);
  write(closeDelim);

  const res = await fetch(
    `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,mimeType,webViewLink`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!res.ok) throw new Error(await driveError(res, 'uploadFile'));
  return (await res.json()) as DriveFile;
}

async function driveError(res: Response, context: string): Promise<string> {
  let body: string;
  try {
    body = await res.text();
  } catch {
    body = '(unreadable body)';
  }
  return `Drive ${context} failed: HTTP ${res.status} — ${body.slice(0, 500)}`;
}
