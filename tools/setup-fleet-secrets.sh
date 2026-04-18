#!/usr/bin/env bash
#
# setup-fleet-secrets.sh — one-time Cloudflare Secrets Store bootstrap.
#
# Creates a Secrets Store named "agentbuilder-fleet", adds fleet-shared
# secrets, and patches every agent's wrangler.toml with [[secrets_store_secrets]]
# bindings so each worker reads from the store instead of per-worker secrets.
#
# Prerequisites:
#   - wrangler >= 4.x (`pnpm install` after upgrading)
#   - Logged in: `npx wrangler login`
#   - Super Administrator or Secrets Store Admin role on the account
#
# Usage:
#   pnpm fleet:setup-secrets
#
# Idempotent — safe to re-run. Will skip secrets that already exist.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1" >&2; exit 1; }

# ── Step 0: Check wrangler ───────────────────────────────────────────────────
WRANGLER="npx wrangler"
$WRANGLER --version >/dev/null 2>&1 || fail "wrangler not found. Run 'pnpm install' first."
info "wrangler $($WRANGLER --version 2>/dev/null | head -1)"

# ── Step 1: Create or find the Secrets Store ─────────────────────────────────
STORE_NAME="agentbuilder-fleet"
echo ""
echo "Looking for Secrets Store '${STORE_NAME}'..."

STORE_ID=$($WRANGLER secrets-store store list --remote 2>/dev/null \
  | grep -i "$STORE_NAME" \
  | head -1 \
  | awk '{print $1}' || true)

if [ -z "$STORE_ID" ]; then
  echo "Creating Secrets Store '${STORE_NAME}'..."
  CREATE_OUTPUT=$($WRANGLER secrets-store store create "$STORE_NAME" --remote 2>&1)
  STORE_ID=$(echo "$CREATE_OUTPUT" | grep -oE '[0-9a-f]{32}' | head -1 || true)
  if [ -z "$STORE_ID" ]; then
    echo "$CREATE_OUTPUT"
    fail "Could not extract store_id from creation output. Check the output above."
  fi
  info "Created Secrets Store: ${STORE_ID}"
else
  info "Found existing Secrets Store: ${STORE_ID}"
fi

# ── Step 2: Add fleet-shared secrets ─────────────────────────────────────────
# These are the secrets shared by multiple agents. Per-agent secrets
# (MCP_HTTP_KEY, TELLER_APPLICATION_ID, etc.) stay as plain worker secrets.

FLEET_SECRETS=(
  "anthropic-api-key:ANTHROPIC_API_KEY"
  "google-oauth-client-id:GOOGLE_OAUTH_CLIENT_ID"
  "google-oauth-client-secret:GOOGLE_OAUTH_CLIENT_SECRET"
  "google-token-vault-kek:GOOGLE_TOKEN_VAULT_KEK"
)

echo ""
echo "Adding fleet-shared secrets to the store..."
echo "(You'll be prompted for each secret value. Paste and press Enter.)"
echo ""

for entry in "${FLEET_SECRETS[@]}"; do
  SECRET_NAME="${entry%%:*}"
  ENV_NAME="${entry##*:}"

  # Check if secret already exists
  EXISTS=$($WRANGLER secrets-store secret list "$STORE_ID" --remote 2>/dev/null \
    | grep -c "$SECRET_NAME" || true)

  if [ "$EXISTS" -gt 0 ]; then
    info "${SECRET_NAME} already exists — skipping."
    continue
  fi

  echo -e "${YELLOW}Enter value for ${ENV_NAME} (${SECRET_NAME}):${NC}"
  read -rs SECRET_VALUE
  echo ""

  if [ -z "$SECRET_VALUE" ]; then
    warn "Empty value for ${SECRET_NAME} — skipping. You can add it later with:"
    echo "  $WRANGLER secrets-store secret create ${STORE_ID} --name ${SECRET_NAME} --scopes workers --remote"
    continue
  fi

  echo "$SECRET_VALUE" | $WRANGLER secrets-store secret create "$STORE_ID" \
    --name "$SECRET_NAME" --scopes workers --remote 2>/dev/null \
    && info "Added ${SECRET_NAME}" \
    || warn "Failed to add ${SECRET_NAME} — add manually later."
done

# ── Step 3: Patch wrangler.toml files ────────────────────────────────────────
# For each agent that uses fleet-shared secrets, append [[secrets_store_secrets]]
# blocks if they don't already exist.

echo ""
echo "Patching wrangler.toml files..."

# Map: agent-dir -> which fleet secrets it needs
declare -A AGENT_SECRETS
AGENT_SECRETS[agent-builder]="anthropic-api-key:ANTHROPIC_API_KEY google-oauth-client-secret:GOOGLE_OAUTH_CLIENT_SECRET"
AGENT_SECRETS[cfo]="anthropic-api-key:ANTHROPIC_API_KEY"
AGENT_SECRETS[chief-of-staff]="google-oauth-client-id:GOOGLE_OAUTH_CLIENT_ID google-oauth-client-secret:GOOGLE_OAUTH_CLIENT_SECRET"
AGENT_SECRETS[graphic-designer]="anthropic-api-key:ANTHROPIC_API_KEY google-oauth-client-id:GOOGLE_OAUTH_CLIENT_ID google-oauth-client-secret:GOOGLE_OAUTH_CLIENT_SECRET google-token-vault-kek:GOOGLE_TOKEN_VAULT_KEK"
# guest-booking and research-agent don't use fleet-shared secrets yet

for AGENT in "${!AGENT_SECRETS[@]}"; do
  TOML="$REPO_ROOT/apps/${AGENT}/wrangler.toml"
  if [ ! -f "$TOML" ]; then
    warn "No wrangler.toml for ${AGENT} — skipping."
    continue
  fi

  # Skip if already patched
  if grep -q "secrets_store_secrets" "$TOML" 2>/dev/null; then
    info "${AGENT}/wrangler.toml already has Secrets Store bindings — skipping."
    continue
  fi

  echo "" >> "$TOML"
  echo "# ── Fleet-shared secrets (Secrets Store) ──────────────────────────────────" >> "$TOML"

  for entry in ${AGENT_SECRETS[$AGENT]}; do
    SECRET_NAME="${entry%%:*}"
    BINDING_NAME="${entry##*:}"
    cat >> "$TOML" <<EOF

[[secrets_store_secrets]]
binding = "${BINDING_NAME}"
store_id = "${STORE_ID}"
secret_name = "${SECRET_NAME}"
EOF
  done

  info "Patched ${AGENT}/wrangler.toml"
done

# ── Step 4: Generate KEK if needed ───────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Setup complete!"
echo ""
echo "If you skipped GOOGLE_TOKEN_VAULT_KEK, generate one with:"
echo "  node -e \"const b=crypto.getRandomValues(new Uint8Array(32));console.log(btoa(String.fromCharCode(...b)))\""
echo "Then add it to the store:"
echo "  $WRANGLER secrets-store secret create ${STORE_ID} --name google-token-vault-kek --scopes workers --remote"
echo ""
echo "Per-agent secrets still need 'wrangler secret put' per worker:"
echo "  • agent-builder: GITHUB_APP_PRIVATE_KEY"
echo "  • cfo: TELLER_APPLICATION_ID, MCP_HTTP_KEY"
echo "  • chief-of-staff: GOOGLE_SERVICE_ACCOUNT_JSON, PPP_SHEETS_SPREADSHEET_ID, MCP_HTTP_KEY, INTERNAL_CRON_KEY, GOOGLE_OAUTH_REFRESH_TOKEN, ZOOM_*, BLUESKY_*"
echo "  • graphic-designer: MCP_HTTP_KEY, OPENAI_API_KEY, UNSPLASH_ACCESS_KEY, PEXELS_API_KEY, CANVA_API_KEY"
echo "  • research-agent: MCP_BEARER_TOKEN, BLUESKY_*"
echo ""
echo "For local dev, create .dev.vars in each agent's directory (gitignored)."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
