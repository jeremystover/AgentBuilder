import type { Env, Entity } from '../types';

const NOTES_PREFIX = 'bookkeeping-notes';

function notesKey(userId: string, entity: Entity): string {
  return `${NOTES_PREFIX}/${userId}/${entity}.md`;
}

export async function readBookkeepingNotes(
  env: Env,
  userId: string,
  entity: Entity,
): Promise<string> {
  const key = notesKey(userId, entity);
  const obj = await env.BUCKET.get(key);
  if (!obj) return '';
  return await obj.text();
}

export async function saveBookkeepingNotes(
  env: Env,
  userId: string,
  entity: Entity,
  content: string,
): Promise<void> {
  const key = notesKey(userId, entity);
  await env.BUCKET.put(key, content, {
    httpMetadata: { contentType: 'text/markdown' },
  });
}
