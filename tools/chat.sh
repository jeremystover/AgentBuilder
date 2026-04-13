#!/usr/bin/env bash
#
# Minimal Architect test harness.
#
# Usage:
#   ./tools/chat.sh "I want an agent that drafts follow-up emails"
#   ./tools/chat.sh "Yes, proceed" $SESSION_ID       # continue existing session
#
# Requires: curl, jq
# Requires: agent-builder running at $AGENT_BUILDER_URL (default http://localhost:8787)
#
# The script prints the reply, session id, and token usage. Save the
# session id and pass it back to continue the conversation with history.

set -euo pipefail

URL="${AGENT_BUILDER_URL:-http://localhost:8787}"
MESSAGE="${1:-}"
SESSION_ID="${2:-}"
PERSONA="${PERSONA:-architect}"

if [[ -z "$MESSAGE" ]]; then
  echo "Usage: $0 \"your message\" [session-id]" >&2
  exit 1
fi

if [[ -z "$SESSION_ID" ]]; then
  BODY=$(jq -n --arg msg "$MESSAGE" --arg p "$PERSONA" \
    '{message: $msg, persona: $p}')
else
  BODY=$(jq -n --arg msg "$MESSAGE" --arg sid "$SESSION_ID" --arg p "$PERSONA" \
    '{message: $msg, sessionId: $sid, persona: $p}')
fi

RESPONSE=$(curl -sS -X POST "$URL/chat" \
  -H 'content-type: application/json' \
  -d "$BODY")

echo "─── reply ──────────────────────────────────────"
echo "$RESPONSE" | jq -r '.reply'
echo ""
echo "─── meta ───────────────────────────────────────"
echo "$RESPONSE" | jq '{sessionId, persona, handoffTo, iterations, usage}'
echo ""
echo "continue:  $0 \"your next message\" $(echo "$RESPONSE" | jq -r '.sessionId')"
