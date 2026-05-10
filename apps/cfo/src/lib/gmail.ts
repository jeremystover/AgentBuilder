import type { Env } from '../types';

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface GmailMessagePart {
  mimeType: string;
  body: { data?: string; size: number };
  parts?: GmailMessagePart[];
  headers?: Array<{ name: string; value: string }>;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string; // epoch millis as string
  payload: GmailMessagePart;
}

export async function refreshAccessToken(env: Env, refreshToken: string): Promise<string> {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID ?? '',
      client_secret: env.GMAIL_CLIENT_SECRET ?? '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) throw new Error(`Gmail token refresh failed: ${await resp.text()}`);
  const data = await resp.json() as { access_token: string };
  return data.access_token;
}

export async function exchangeCodeForTokens(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token: string; email: string }> {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GMAIL_CLIENT_ID ?? '',
      client_secret: env.GMAIL_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!resp.ok) throw new Error(`Gmail OAuth exchange failed: ${await resp.text()}`);
  const data = await resp.json() as { access_token: string; refresh_token: string };

  const infoResp = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  const info = await infoResp.json() as { email?: string };

  return { access_token: data.access_token, refresh_token: data.refresh_token, email: info.email ?? '' };
}

export async function searchMessages(
  accessToken: string,
  query: string,
  maxResults = 200,
): Promise<GmailMessageRef[]> {
  const results: GmailMessageRef[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(Math.min(maxResults - results.length, 100)));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) throw new Error(`Gmail search failed: ${await resp.text()}`);
    const data = await resp.json() as { messages?: GmailMessageRef[]; nextPageToken?: string };

    results.push(...(data.messages ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken && results.length < maxResults);

  return results;
}

export async function getMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) throw new Error(`Gmail getMessage failed: ${await resp.text()}`);
  return resp.json() as Promise<GmailMessage>;
}

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '=='.slice(0, (4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function extractPart(part: GmailMessagePart, mimeType: string): string | null {
  if (part.mimeType === mimeType && part.body.data) return decodeBase64Url(part.body.data);
  if (part.parts) {
    for (const sub of part.parts) {
      const found = extractPart(sub, mimeType);
      if (found) return found;
    }
  }
  return null;
}

export function getMessageBody(message: GmailMessage): { text: string; html: string } {
  return {
    html: extractPart(message.payload, 'text/html') ?? '',
    text: extractPart(message.payload, 'text/plain') ?? '',
  };
}

export function getHeader(message: GmailMessage, name: string): string {
  return message.payload.headers
    ?.find(h => h.name.toLowerCase() === name.toLowerCase())
    ?.value ?? '';
}
