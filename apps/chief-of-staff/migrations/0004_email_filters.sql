-- 0004_email_filters.sql
-- Adds EmailFilters table for watching specific emails by sender or body content.
--
-- Apply with:
--   wrangler d1 execute chief-of-staff-db --file=migrations/0004_email_filters.sql
--
-- Filters can match on:
--   - from: sender email pattern (substring match, case-insensitive)
--   - bodyKeywords: JSON array of keywords to find in body (substring match, case-insensitive)
--
-- Matched emails are recorded in FlaggedEmails for tracking and surfacing to the agent.

CREATE TABLE IF NOT EXISTS EmailFilters (
  _row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filterId         TEXT DEFAULT '',        -- unique identifier
  name             TEXT DEFAULT '',        -- user-friendly name (e.g., "Teaching Schedule Form")
  description      TEXT DEFAULT '',        -- what this filter catches
  senderPattern    TEXT DEFAULT '',        -- substring to match in From header (empty = no match)
  bodyKeywordsJson TEXT DEFAULT '',        -- JSON array of keywords (case-insensitive)
  priority         TEXT DEFAULT 'medium',  -- 'high', 'medium', 'low'
  enabled          TEXT DEFAULT '1',       -- '1' = enabled, '0' = disabled
  createdAt        TEXT DEFAULT '',
  updatedAt        TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_emailfilters_filterId ON EmailFilters(filterId);
CREATE INDEX IF NOT EXISTS idx_emailfilters_enabled  ON EmailFilters(enabled);

-- ── FlaggedEmails ────────────────────────────────────────────────────────────
-- Records emails that matched one or more filters.
-- Allows tracking which emails have been surfaced and actioned.

CREATE TABLE IF NOT EXISTS FlaggedEmails (
  _row_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  flagId         TEXT DEFAULT '',         -- unique identifier
  filterId       TEXT DEFAULT '',         -- which filter(s) matched (comma-separated)
  messageId      TEXT DEFAULT '',         -- Gmail message ID
  threadId       TEXT DEFAULT '',         -- Gmail thread ID
  subject        TEXT DEFAULT '',         -- subject line
  from_addr      TEXT DEFAULT '',         -- sender email
  date           TEXT DEFAULT '',         -- email date
  snippet        TEXT DEFAULT '',         -- preview of content
  priority       TEXT DEFAULT 'medium',   -- highest priority from matching filters
  status         TEXT DEFAULT 'new',      -- 'new', 'reviewed', 'actioned', 'dismissed'
  surfacedAt     TEXT DEFAULT '',         -- when first surfaced to agent
  actionedAt     TEXT DEFAULT '',         -- when user took action
  actionNotes    TEXT DEFAULT '',         -- notes on what action was taken
  flaggedAt      TEXT DEFAULT ''          -- when this was flagged
);

CREATE INDEX IF NOT EXISTS idx_flaggedemails_flagId     ON FlaggedEmails(flagId);
CREATE INDEX IF NOT EXISTS idx_flaggedemails_messageId  ON FlaggedEmails(messageId);
CREATE INDEX IF NOT EXISTS idx_flaggedemails_status     ON FlaggedEmails(status);
CREATE INDEX IF NOT EXISTS idx_flaggedemails_priority   ON FlaggedEmails(priority);
CREATE INDEX IF NOT EXISTS idx_flaggedemails_flaggedAt  ON FlaggedEmails(flaggedAt);
