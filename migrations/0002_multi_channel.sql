-- Migration 0002: support several channels in one bot.
-- `users.source_channel_id` is the first channel that produced a join request.
-- `channel_members` records per-channel membership discovered from join requests
-- and (best-effort) chat_member updates.

ALTER TABLE users ADD COLUMN source_channel_id INTEGER;

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id INTEGER NOT NULL,
  telegram_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members (telegram_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_channel ON channel_members (channel_id, status);
