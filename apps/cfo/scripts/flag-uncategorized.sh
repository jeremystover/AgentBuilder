#!/usr/bin/env bash
set -euo pipefail

DB="cfo-db"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "Error: CLOUDFLARE_API_TOKEN is not set." >&2
  exit 1
fi

echo "=== Preview: transactions with no budget or tax category ==="
wrangler d1 execute "$DB" --remote --command="
  SELECT
    COUNT(*) AS total_affected,
    SUM(CASE WHEN rq.id IS NOT NULL THEN 1 ELSE 0 END) AS already_in_review_queue
  FROM classifications c
  LEFT JOIN review_queue rq ON rq.transaction_id = c.transaction_id
  WHERE c.category_budget IS NULL
    AND c.category_tax IS NULL
    AND c.is_locked = 0;
"

echo ""
read -rp "Proceed with flagging these transactions? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "=== Running flag-uncategorized.sql ==="
wrangler d1 execute "$DB" --remote --file="$SCRIPT_DIR/flag-uncategorized.sql"
echo "Done."
