-- Migration 0001: users, messages, broadcasts, channel links, settings, admin sessions.
-- Existing KV namespace is kept untouched.

CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  private_chat_id INTEGER,
  dm_status TEXT NOT NULL DEFAULT 'unknown',
  can_receive_messages INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  first_seen_at TEXT NOT NULL,
  join_requested_at TEXT,
  approved_at TEXT,
  consent_broadcasts INTEGER NOT NULL DEFAULT 0,
  consent_at TEXT,
  consent_source TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_dm ON users (can_receive_messages, dm_status);
CREATE INDEX IF NOT EXISTS idx_users_started ON users (started_at);
CREATE INDEX IF NOT EXISTS idx_users_approved ON users (approved_at);
CREATE INDEX IF NOT EXISTS idx_users_consent ON users (consent_broadcasts);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL DEFAULT 'out',
  kind TEXT NOT NULL,
  broadcast_id INTEGER,
  content_type TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code INTEGER,
  error_description TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_user ON messages (telegram_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_broadcast ON messages (broadcast_id);

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  text TEXT,
  caption TEXT,
  file_id TEXT,
  parse_mode TEXT,
  buttons_json TEXT,
  audience TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  total INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  unreachable INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  cursor INTEGER,
  rate_per_sec INTEGER NOT NULL DEFAULT 20,
  last_error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  paused_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts (status, updated_at);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  broadcast_id INTEGER NOT NULL,
  telegram_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code INTEGER,
  error_description TEXT,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (broadcast_id, telegram_id),
  FOREIGN KEY (broadcast_id) REFERENCES broadcasts (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recipients_pending
  ON broadcast_recipients (broadcast_id, status, telegram_id);

CREATE TABLE IF NOT EXISTS channel_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'extra',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  admin_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  payload TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by) VALUES (
  'welcome',
  '{"enabled":true,"contentType":"text","text":"<b>Добро пожаловать!</b>\n\nСпасибо за вступление в наш канал!\n\nПодписывайся также на наш дополнительный канал, чтобы не пропускать важные обновления.","caption":"","parseMode":"HTML","buttons":[{"text":"ПЕРЕЙТИ В КАНАЛ","link":"main"}]}',
  '2026-11-07T00:00:00.000Z',
  NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by) VALUES (
  'broadcast_rate',
  '20',
  '2026-11-07T00:00:00.000Z',
  NULL
);
