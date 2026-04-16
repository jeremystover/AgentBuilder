# Phase 4: Production Secrets Setup

This document covers how to configure the production security infrastructure for AgentBuilder and its fleet of agents.

## Overview

Phase 4 implements two critical security features:

1. **GitHub App Authentication** — the Builder persona mints installation tokens to open real PRs
2. **Google Token Vault Encryption** — sensitive Google OAuth tokens are encrypted at rest with AES-256-GCM

Both require secrets stored in Cloudflare Secrets and proper key material setup.

## 1. GitHub App Setup

### Prerequisites

1. Create a GitHub App in your organization (Settings > Developer settings > GitHub Apps)
2. Generate and download the private key (`.pem` file)
3. Install the app on your repositories

### Environment Variables

Store these secrets in Cloudflare Secrets using `wrangler`:

```bash
# The GitHub App ID (visible in GitHub App settings)
wrangler secret put GITHUB_APP_ID --name agent-builder

# The GitHub App installation ID (the single org-level installation)
# View your installation: https://github.com/settings/installations
wrangler secret put GITHUB_APP_INSTALLATION_ID --name agent-builder

# The private key (PEM format, entire file contents)
wrangler secret put GITHUB_APP_PRIVATE_KEY --name agent-builder
```

### Using the Client

In any agent's Worker code:

```typescript
import { GitHubClient } from '@agentbuilder/auth-github';

const githubClient = new GitHubClient({
  config: {
    appId: env.GITHUB_APP_ID,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
  },
});

// Mint a token scoped to specific repos
const token = await githubClient.getInstallationToken([
  'repo-1',
  'repo-2',
]);
// token.token — usable with GitHub API
// token.expiresAt — expiration timestamp (ms since epoch)
```

## 2. Google OAuth Token Vault Setup

### Prerequisites

1. Create a Google Cloud OAuth 2.0 Client ID
2. Generate a 256-bit (32-byte) AES key for the KEK (Key Encryption Key)
3. Store the KEK in Cloudflare Secrets

### Generating the KEK

**Option A: Generate in a Node.js REPL**

```bash
node -e "
const key = crypto.getRandomValues(new Uint8Array(32));
console.log(Buffer.from(key).toString('base64'));
"
```

**Option B: Using the crypto utilities**

```typescript
import { generateKey, exportKey } from '@agentbuilder/auth-google';

const key = await generateKey();
const exported = await exportKey(key);
const base64 = Buffer.from(exported).toString('base64');
console.log('Store in Cloudflare Secrets:', base64);
```

### Environment Variables

```bash
# Store the base64-encoded KEK
wrangler secret put GOOGLE_TOKEN_VAULT_KEK --name agent-builder
```

### Using the Vault

In any agent's Worker code:

```typescript
import { D1TokenVault, importKey } from '@agentbuilder/auth-google';

// Decode the KEK from Secrets
const kekBuffer = Buffer.from(env.GOOGLE_TOKEN_VAULT_KEK, 'base64');
const kek = await importKey(kekBuffer);

// Create the vault with the KEK
const vault = new D1TokenVault({
  db: env.AGENTBUILDER_CORE,
  encryptionKey: kek,
});

// All reads/writes are now encrypted
const token = await vault.get({ agentId: 'my-agent', userId: 'user-123' });
await vault.put({
  agentId: 'my-agent',
  userId: 'user-123',
  scopes: ['openid', 'email'],
  accessToken: 'access_token_value',
  refreshToken: 'refresh_token_value',
  expiresAt: Date.now() + 3600000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
```

## 3. Database Schema

The Google token vault requires a D1 table. Apply the schema once per database:

```bash
wrangler d1 execute agentbuilder-core --remote \
  --command "$(node -e 'import(\"./packages/auth-google/src/schema.js\").then(m => console.log(m.GOOGLE_TOKEN_VAULT_SCHEMA))')"
```

Or manually:

```sql
CREATE TABLE IF NOT EXISTS google_tokens (
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, user_id)
);
```

## 4. Key Rotation

### Rotating the Google KEK

When rotating the KEK (recommended: annually or after a security event):

1. Generate a new key following step 2 above
2. Decrypt all tokens with the old key, re-encrypt with the new key
3. Update `GOOGLE_TOKEN_VAULT_KEK` in Cloudflare Secrets
4. Delete the old key material (never keep it around)

Example migration script (runs in a Worker or Node.js):

```typescript
import { D1TokenVault, importKey } from '@agentbuilder/auth-google';

async function rotateKek(
  db: D1Database,
  oldKekBase64: string,
  newKekBase64: string,
) {
  const oldKek = await importKey(Buffer.from(oldKekBase64, 'base64'));
  const newKek = await importKey(Buffer.from(newKekBase64, 'base64'));

  const oldVault = new D1TokenVault({ db, encryptionKey: oldKek });
  const newVault = new D1TokenVault({ db, encryptionKey: newKek });

  // Iterate all tokens
  const rows = await db.prepare('SELECT DISTINCT agent_id FROM google_tokens').all();
  for (const row of rows.results ?? []) {
    const tokens = await db
      .prepare('SELECT * FROM google_tokens WHERE agent_id = ?')
      .bind(row.agent_id)
      .all();

    for (const token of tokens.results ?? []) {
      // Decrypt with old key, re-encrypt with new key
      const decrypted = await oldVault.get({
        agentId: token.agent_id,
        userId: token.user_id,
      });
      if (decrypted) {
        await newVault.put(decrypted);
      }
    }
  }
}
```

### GitHub App Key Rotation

GitHub App private keys cannot be rotated directly, but you can:

1. Generate a new private key in GitHub App settings
2. Update `GITHUB_APP_PRIVATE_KEY` in Cloudflare Secrets
3. The old key will be invalidated server-side

## 5. Security Best Practices

- **Never commit secrets** — use `wrangler secret` only
- **Encrypt in transit** — GitHub App JWTs have 10-minute expiry; tokens expire in 1 hour
- **Audit access** — log all token reads/writes through the vault
- **Rotate keys annually** — especially for the KEK
- **Use environment-specific secrets** — dev, staging, and production should have separate keys

## 6. Testing Locally

For local development without storing secrets in Cloudflare:

```typescript
import { generateKey } from '@agentbuilder/auth-google';

// In .dev.vars (wrangler reads this)
// GITHUB_APP_ID = "12345"
// GITHUB_APP_INSTALLATION_ID = "67890"
// GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\n..."

// For the KEK, generate locally each run:
const localKek = await generateKey();
const vault = new D1TokenVault({
  db: env.AGENTBUILDER_CORE,
  encryptionKey: localKek,
});
```

This way, tokens are encrypted even in dev but you don't need to manage secrets.
