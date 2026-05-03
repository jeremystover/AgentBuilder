/**
 * Drop-in REST surface for the credential vault. Any worker that owns a
 * D1CredentialVault can mount this to expose put/get/list/delete over
 * HTTP, gated by a caller-supplied auth check.
 *
 * Path layout (mounted under any prefix the worker chooses, e.g.
 *   "/credentials"):
 *
 *   GET    /                          → list all (?provider= optional)
 *   GET    /:account/:provider/:kind  → fetch one (returns plaintext value)
 *   PUT    /:account/:provider/:kind  → upsert one
 *                                       body: { value, metadata?, expiresAt? }
 *   DELETE /:account/:provider/:kind  → remove one
 *
 * Returns null when the request doesn't match the prefix so the host
 * router can keep dispatching.
 */

import type { CredentialKind, StoredCredential } from './types.js';
import type { CredentialVault } from './vault.js';

export interface MountCredentialsApiOptions {
  vault: CredentialVault;
  /** The agent owning this vault. Every read/write is scoped here. */
  agentId: string;
  /** Path prefix the API lives under (e.g. "/credentials"). No trailing slash. */
  prefix: string;
  /** Auth gate. Return false to reject with 401. */
  isAuthorized: (request: Request) => boolean | Promise<boolean>;
}

const KINDS: ReadonlySet<CredentialKind> = new Set([
  'cookie', 'session_jwt', 'api_key', 'bearer', 'basic',
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function publicShape(c: StoredCredential): Record<string, unknown> {
  return {
    agentId:   c.agentId,
    accountId: c.accountId,
    provider:  c.provider,
    kind:      c.kind,
    value:     c.value,
    metadata:  c.metadata,
    expiresAt: c.expiresAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export async function mountCredentialsApi(
  request: Request,
  opts: MountCredentialsApiOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  const prefix = opts.prefix.replace(/\/+$/, '');
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;

  const authorized = await opts.isAuthorized(request);
  if (!authorized) return new Response('Unauthorized', { status: 401 });

  const subpath = url.pathname.slice(prefix.length).replace(/^\/+/, '');
  const segments = subpath.length === 0 ? [] : subpath.split('/');

  if (request.method === 'GET' && segments.length === 0) {
    const provider = url.searchParams.get('provider') ?? undefined;
    const accountId = url.searchParams.get('account') ?? undefined;
    const list = await opts.vault.list({ agentId: opts.agentId, provider, accountId });
    return json(list.map(publicShape));
  }

  if (segments.length !== 3) {
    return json({ error: `Expected ${prefix}/<account>/<provider>/<kind>` }, 400);
  }
  const [accountId, provider, kindRaw] = segments as [string, string, string];
  if (!KINDS.has(kindRaw as CredentialKind)) {
    return json({ error: `Unknown kind "${kindRaw}". Valid: ${[...KINDS].join(', ')}` }, 400);
  }
  const kind = kindRaw as CredentialKind;
  const key = { agentId: opts.agentId, accountId, provider, kind };

  if (request.method === 'GET') {
    const cred = await opts.vault.get(key);
    if (!cred) return json({ error: 'Not found' }, 404);
    return json(publicShape(cred));
  }

  if (request.method === 'PUT') {
    let body: { value?: string; metadata?: Record<string, unknown>; expiresAt?: number };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: 'Body must be JSON' }, 400);
    }
    if (!body.value || typeof body.value !== 'string') {
      return json({ error: '`value` (string) is required' }, 400);
    }
    const now = Date.now();
    const existing = await opts.vault.get(key);
    await opts.vault.put({
      ...key,
      value:     body.value,
      metadata:  body.metadata ?? null,
      expiresAt: body.expiresAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return json({ ok: true, ...key });
  }

  if (request.method === 'DELETE') {
    await opts.vault.delete(key);
    return json({ ok: true });
  }

  return json({ error: `Method ${request.method} not allowed` }, 405);
}
