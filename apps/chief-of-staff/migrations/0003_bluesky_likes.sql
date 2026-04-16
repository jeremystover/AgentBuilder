-- 0003_bluesky_likes.sql
-- Adds the BlueskyLikes table for tracking liked posts ingested from Bluesky.
--
-- Apply with:
--   wrangler d1 execute chief-of-staff-db --file=migrations/0003_bluesky_likes.sql
--
-- The UNIQUE index on likeUri prevents duplicate imports if the ingest loop
-- encounters the same like record across multiple runs.

CREATE TABLE IF NOT EXISTS BlueskyLikes (
  _row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  likeId           TEXT DEFAULT '',  -- internal generated ID (bsky_<ts>_<rand>)
  likeUri          TEXT DEFAULT '',  -- AT-proto URI of the like record itself
  postUri          TEXT DEFAULT '',  -- AT-proto URI of the liked post
  postCid          TEXT DEFAULT '',  -- content hash of the liked post at like time
  postAuthorDid    TEXT DEFAULT '',  -- DID of the post author
  postAuthorHandle TEXT DEFAULT '',  -- handle of the post author (e.g. "user.bsky.social")
  postAuthorName   TEXT DEFAULT '',  -- display name of the post author
  postText         TEXT DEFAULT '',  -- full text of the liked post (up to 1000 chars)
  postCreatedAt    TEXT DEFAULT '',  -- ISO timestamp when the post was published
  likedAt          TEXT DEFAULT '',  -- ISO timestamp when the like was created
  payloadJson      TEXT DEFAULT '',  -- full raw JSON of the like record + resolved post
  importedAt       TEXT DEFAULT ''   -- ISO timestamp when we imported this row
);

-- Prevent double-importing the same like across runs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bluesky_likes_likeUri
  ON BlueskyLikes(likeUri);

-- Fast recency queries for list_bluesky_likes tool and content curation.
CREATE INDEX IF NOT EXISTS idx_bluesky_likes_likedAt
  ON BlueskyLikes(likedAt);
