#!/usr/bin/env tsx
/**
 * create-agent — scaffold a new agent from a template and register it.
 *
 * Usage:
 *   pnpm create-agent <id> --kind headless|app --name "Display Name" \
 *     --purpose "One sentence." --owner you
 *
 * The CLI:
 *   1. copies .agent-builder/templates/<kind>-agent/** to apps/<id>/**
 *   2. replaces __AGENT_ID__ / __AGENT_NAME__ / __AGENT_PURPOSE__ / __AGENT_CLASS__
 *   3. upserts a draft entry in registry/agents.json
 *   4. renders .github/workflows/deploy-<id>.yml from the shared template
 *      so every new agent has Cloudflare deploy + D1 migration CI wired up
 *
 * After scaffolding, run `pnpm install && pnpm --filter @agentbuilder/app-<id> typecheck`.
 */

import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEntry } from '@agentbuilder/registry';
import { FileRegistryStore } from '@agentbuilder/registry/node';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');

type Kind = 'headless' | 'app';

interface Args {
  id: string;
  kind: Kind;
  name: string;
  purpose: string;
  owner: string;
  d1Database: string;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        flags.set(key, val);
        i++;
      }
    }
  }

  const id = positional[0];
  if (!id) throw new Error('Missing agent id. Usage: create-agent <id> --kind ... --name ...');
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Agent id must be kebab-case.');

  const kind = (flags.get('kind') ?? 'headless') as Kind;
  if (kind !== 'headless' && kind !== 'app') throw new Error('--kind must be headless or app');

  const name = flags.get('name') ?? id;
  const purpose = flags.get('purpose') ?? `TODO: describe ${id}`;
  const owner = flags.get('owner') ?? 'unknown';
  const d1Database = flags.get('d1-database') ?? '';

  return { id, kind, name, purpose, owner, d1Database };
}

function classNameFor(id: string): string {
  return `${id
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('')}`;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

function applyReplacements(src: string, args: Args): string {
  const className = classNameFor(args.id);
  return src
    .replaceAll('__AGENT_ID__', args.id)
    .replaceAll('__AGENT_NAME__', args.name)
    .replaceAll('__AGENT_PURPOSE__', args.purpose)
    .replaceAll('__AGENT_CLASS__', className)
    .replaceAll('__AGENT_D1_DATABASE__', args.d1Database ? `'${args.d1Database}'` : `''`);
}

async function copyTemplate(args: Args): Promise<string> {
  const templateDir = resolve(REPO_ROOT, `.agent-builder/templates/${args.kind}-agent`);
  const destDir = resolve(REPO_ROOT, `apps/${args.id}`);
  await mkdir(destDir, { recursive: true });

  for (const file of await walk(templateDir)) {
    const rel = relative(templateDir, file);
    const destPath = join(destDir, rel.replace(/\.tmpl$/, ''));
    await mkdir(resolve(destPath, '..'), { recursive: true });
    const src = await readFile(file, 'utf8');
    await writeFile(destPath, applyReplacements(src, args), 'utf8');
  }

  return destDir;
}

async function writeDeployWorkflow(args: Args): Promise<string> {
  const templatePath = resolve(REPO_ROOT, '.agent-builder/templates/common/deploy.yml.tmpl');
  const destPath = resolve(REPO_ROOT, `.github/workflows/deploy-${args.id}.yml`);
  await mkdir(resolve(destPath, '..'), { recursive: true });
  const src = await readFile(templatePath, 'utf8');
  await writeFile(destPath, applyReplacements(src, args), 'utf8');
  return destPath;
}

async function registerAgent(args: Args): Promise<void> {
  const store = FileRegistryStore.fromRepoRoot(REPO_ROOT);
  const entry: AgentEntry = {
    id: args.id,
    name: args.name,
    purpose: args.purpose,
    owner: args.owner,
    status: 'draft',
    kind: args.kind,
    skills: [],
    tools: [],
    mcpServers: [],
    sharedPackages: ['@agentbuilder/core', '@agentbuilder/llm'],
    oauthScopes: [],
    cloudflare: {
      workerName: args.id,
      durableObjects: [`${classNameFor(args.id)}DO`],
      d1: [],
      kv: [],
      r2: [],
      queues: [],
      hasAssets: args.kind === 'app',
    },
    routing: {
      triggerPhrases: [],
      examples: [],
      nonGoals: [],
    },
    crons: [],
    secrets: [],
    version: '0.0.1',
  };
  await store.upsertAgent(entry);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dest = await copyTemplate(args);
  const workflow = await writeDeployWorkflow(args);
  await registerAgent(args);

  console.log(`✓ Scaffolded ${args.kind}-agent at ${relative(REPO_ROOT, dest)}`);
  console.log(`✓ Registered ${args.id} in registry/agents.json (status: draft)`);
  console.log(`✓ Wrote deploy workflow at ${relative(REPO_ROOT, workflow)}`);
  console.log('\nNext steps:');
  console.log('  1. pnpm install');
  console.log(`  2. pnpm --filter @agentbuilder/app-${args.id} typecheck`);
  console.log(`  3. Fill in apps/${args.id}/SKILL.md (non-goals, tools, routing)`);
  console.log(`  4. pnpm --filter @agentbuilder/app-${args.id} dev`);
  console.log(`  5. As you add features, keep the registry in sync:`);
  console.log(`       - tools[], toolDescriptions{}  → describe each tool`);
  console.log(`       - secrets[]                    → every name passed to \`wrangler secret put\``);
  console.log(`       - crons[]                      → matching schedule + trigger names if you add scheduled() (see AGENTS.md rule 11)`);
  if (!args.d1Database) {
    console.log(
      `  6. When you add D1 to wrangler.toml, set d1_database in ${relative(REPO_ROOT, workflow)}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
