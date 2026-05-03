#!/usr/bin/env tsx
/**
 * cred — manage credential-vault entries on any deployed watcher.
 *
 * Each watcher exposes a /credentials/* REST surface (mountCredentialsApi
 * from @agentbuilder/credential-vault). This CLI is a thin client over
 * that surface — no D1 access, no local KEK handling. Configure each
 * watcher's URL + API key in ~/.agentbuilder/credentials.json:
 *
 *   {
 *     "medium-watcher": {
 *       "url": "https://medium-watcher.you.workers.dev",
 *       "apiKey": "..."
 *     },
 *     "wired-watcher":  { "url": "...", "apiKey": "..." }
 *   }
 *
 * Usage:
 *   pnpm cred genkey
 *   pnpm cred list   <agent> [--provider X] [--account Y]
 *   pnpm cred get    <agent> <account> <provider> <kind>
 *   pnpm cred put    <agent> <account> <provider> <kind> [--expires-at ms]
 *                    [--metadata '{"k":"v"}']
 *                    (reads value from stdin so cookies don't end up in shell history)
 *   pnpm cred delete <agent> <account> <provider> <kind>
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stdin } from 'node:process';

interface AgentConfig { url: string; apiKey: string }
type ConfigFile = Record<string, AgentConfig>;

const CONFIG_PATH = join(homedir(), '.agentbuilder', 'credentials.json');

async function loadConfig(): Promise<ConfigFile> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as ConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      die(`No config at ${CONFIG_PATH}. Create it with:\n  {"medium-watcher":{"url":"https://...","apiKey":"..."}}`);
    }
    throw err;
  }
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(a.slice(2), next);
        i++;
      } else {
        flags.set(a.slice(2), 'true');
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { data += chunk; });
    stdin.on('end',  () => resolve(data.replace(/\r?\n$/, '')));
    stdin.on('error', reject);
  });
}

async function callAgent(
  agent: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const config = await loadConfig();
  const cfg = config[agent];
  if (!cfg) die(`Unknown agent "${agent}". Configured: ${Object.keys(config).join(', ') || '(none)'}`);

  const url = `${cfg.url.replace(/\/+$/, '')}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };

  const resp = await fetch(url, init);
  const text = await resp.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep as string */ }
  if (!resp.ok) {
    die(`HTTP ${resp.status} ${resp.statusText}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

function genkey(): void {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Stdout is the key only — nothing else, so callers can pipe into
  // `wrangler secret put` without grep/head gymnastics. Note that pnpm
  // adds its own preamble unless invoked with --silent; the docs use
  // `openssl rand -base64 32` instead, which has no such issue.
  process.stdout.write(`${Buffer.from(bytes).toString('base64')}\n`);
}

async function cmdList(positional: string[], flags: Map<string, string>): Promise<void> {
  const [agent] = positional;
  if (!agent) die('Usage: cred list <agent> [--provider X] [--account Y]');
  const params = new URLSearchParams();
  const provider = flags.get('provider');
  const account  = flags.get('account');
  if (provider) params.set('provider', provider);
  if (account)  params.set('account', account);
  const suffix = params.toString() ? `?${params}` : '';
  const out = await callAgent(agent, 'GET', `/credentials${suffix}`);
  console.log(JSON.stringify(out, null, 2));
}

async function cmdGet(positional: string[]): Promise<void> {
  const [agent, account, provider, kind] = positional;
  if (!agent || !account || !provider || !kind) die('Usage: cred get <agent> <account> <provider> <kind>');
  const out = await callAgent(agent, 'GET', `/credentials/${enc(account)}/${enc(provider)}/${enc(kind)}`);
  console.log(JSON.stringify(out, null, 2));
}

async function cmdPut(positional: string[], flags: Map<string, string>): Promise<void> {
  const [agent, account, provider, kind] = positional;
  if (!agent || !account || !provider || !kind) die('Usage: cred put <agent> <account> <provider> <kind>');

  console.error('Reading credential value from stdin (Ctrl-D to finish)…');
  const value = await readStdin();
  if (!value) die('Empty value — aborted.');

  const body: Record<string, unknown> = { value };
  const expiresAt = flags.get('expires-at');
  if (expiresAt) body['expiresAt'] = Number(expiresAt);
  const metadataRaw = flags.get('metadata');
  if (metadataRaw) {
    try { body['metadata'] = JSON.parse(metadataRaw); }
    catch { die('--metadata must be valid JSON'); }
  }

  const out = await callAgent(agent, 'PUT', `/credentials/${enc(account)}/${enc(provider)}/${enc(kind)}`, body);
  console.log(JSON.stringify(out, null, 2));
}

async function cmdDelete(positional: string[]): Promise<void> {
  const [agent, account, provider, kind] = positional;
  if (!agent || !account || !provider || !kind) die('Usage: cred delete <agent> <account> <provider> <kind>');
  const out = await callAgent(agent, 'DELETE', `/credentials/${enc(account)}/${enc(provider)}/${enc(kind)}`);
  console.log(JSON.stringify(out, null, 2));
}

function enc(s: string): string { return encodeURIComponent(s); }

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case 'genkey':           genkey(); break;
    case 'list':   await cmdList(positional, flags); break;
    case 'get':    await cmdGet(positional); break;
    case 'put':    await cmdPut(positional, flags); break;
    case 'delete':
    case 'rm':     await cmdDelete(positional); break;
    default:
      die(
        'Usage:\n' +
        '  cred genkey\n' +
        '  cred list   <agent> [--provider X] [--account Y]\n' +
        '  cred get    <agent> <account> <provider> <kind>\n' +
        '  cred put    <agent> <account> <provider> <kind> [--expires-at ms] [--metadata JSON]\n' +
        '  cred delete <agent> <account> <provider> <kind>',
      );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
