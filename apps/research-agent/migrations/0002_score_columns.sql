-- Add relevance scoring columns to articles
-- Referenced by score_content tool (src/mcp/tools/score_content.ts)
ALTER TABLE articles ADD COLUMN IF NOT EXISTS relevance_score REAL;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS scored_at       TEXT;
