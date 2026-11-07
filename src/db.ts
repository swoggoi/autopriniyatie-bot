import type {
  AdminSession,
  AudienceSegment,
  BroadcastRow,
  StoredButton,
  TelegramUser,
  WelcomeConfig,
} from './types';
import { DEFAULT_WELCOME } from './defaults';

export const nowIso = (): string => new Date().toISOString();

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(
  db: D1Database,
  key: string,
  value: string,
  updatedBy?: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(key, value, nowIso(), updatedBy ?? null)
    .run();
}

export async function getWelcomeConfig(db: D1Database): Promise<WelcomeConfig> {
  const raw = await getSetting(db, 'welcome');
  if (!raw) return { ...DEFAULT_WELCOME };
  try {
    const parsed = JSON.parse(raw) as Partial<WelcomeConfig>;
    return {
      ...DEFAULT_WELCOME,
      ...parsed,
      contentType: parsed.contentType ?? DEFAULT_WELCOME.contentType,
      buttons: Array.isArray(parsed.buttons) ? parsed.buttons : DEFAULT_WELCOME.buttons,
    };
  } catch {
    return { ...DEFAULT_WELCOME };
  }
}

export async function setWelcomeConfig(
  db: D1Database,
  config: WelcomeConfig,
  updatedBy?: number,
): Promise<void> {
  await setSetting(db, 'welcome', JSON.stringify(config), updatedBy);
}

export async function getBroadcastRate(db: D1Database): Promise<number> {
  const raw = await getSetting(db, 'broadcast_rate');
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(1, Math.min(28, Math.floor(parsed)));
}

export async function setBroadcastRate(db: D1Database, rate: number, updatedBy?: number): Promise<void> {
  await setSetting(db, 'broadcast_rate', String(Math.max(1, Math.min(28, Math.floor(rate)))), updatedBy);
}

// ---------------------------------------------------------------- users

export async function upsertUser(db: D1Database, from: TelegramUser): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (telegram_id, username, first_name, last_name, first_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET
         username = excluded.username,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         updated_at = excluded.updated_at`,
    )
    .bind(
      from.id,
      from.username ?? null,
      from.first_name ?? null,
      from.last_name ?? null,
      now,
      now,
      now,
    )
    .run();
}

/**
 * Creates a minimal user row if it does not exist yet. Used by background jobs
 * that may run for a user whose registration write did not reach D1.
 */
export async function ensureUser(db: D1Database, userId: number): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (telegram_id, first_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(telegram_id) DO NOTHING`,
    )
    .bind(userId, now, now, now)
    .run();
}

export async function recordJoinRequest(
  db: D1Database,
  from: TelegramUser,
  userChatId: number | undefined,
  date: number,
): Promise<void> {
  await upsertUser(db, from);
  const now = nowIso();
  await db
    .prepare(
      `UPDATE users SET
         join_requested_at = ?,
         private_chat_id = COALESCE(?, private_chat_id),
         updated_at = ?
       WHERE telegram_id = ?`,
    )
    .bind(new Date(date * 1000).toISOString(), userChatId ?? null, now, from.id)
    .run();
}

export async function markApproved(db: D1Database, userId: number): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE users SET approved_at = COALESCE(approved_at, ?), updated_at = ? WHERE telegram_id = ?`,
    )
    .bind(now, now, userId)
    .run();
}

export async function markStarted(
  db: D1Database,
  from: TelegramUser,
  privateChatId: number | undefined,
): Promise<void> {
  await upsertUser(db, from);
  const now = nowIso();
  await db
    .prepare(
      `UPDATE users SET
         started_at = COALESCE(started_at, ?),
         dm_status = 'allowed',
         can_receive_messages = 1,
         private_chat_id = COALESCE(?, private_chat_id),
         updated_at = ?
       WHERE telegram_id = ?`,
    )
    .bind(now, privateChatId ?? null, now, from.id)
    .run();
}

export async function setDmStatus(
  db: D1Database,
  userId: number,
  status: 'allowed' | 'blocked' | 'unreachable' | 'unknown',
  error?: string,
): Promise<void> {
  const now = nowIso();
  const canReceive = status === 'allowed' ? 1 : 0;
  await db
    .prepare(
      `UPDATE users SET dm_status = ?, can_receive_messages = ?, last_error = ?, updated_at = ? WHERE telegram_id = ?`,
    )
    .bind(status, canReceive, error ?? null, now, userId)
    .run();
}

export async function setConsent(
  db: D1Database,
  userId: number,
  consent: boolean,
  source: string,
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE users SET consent_broadcasts = ?, consent_at = ?, consent_source = ?, updated_at = ? WHERE telegram_id = ?`,
    )
    .bind(consent ? 1 : 0, consent ? now : null, source, now, userId)
    .run();
}

export interface UserRow {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  private_chat_id: number | null;
  dm_status: string;
  can_receive_messages: number;
  started_at: string | null;
  first_seen_at: string;
  join_requested_at: string | null;
  approved_at: string | null;
  consent_broadcasts: number;
  consent_at: string | null;
  consent_source: string | null;
  last_error: string | null;
}

export async function getUser(db: D1Database, userId: number): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').bind(userId).first<UserRow>();
}

export async function listRecentUsers(db: D1Database, limit = 10): Promise<UserRow[]> {
  const res = await db
    .prepare('SELECT * FROM users ORDER BY updated_at DESC LIMIT ?')
    .bind(limit)
    .all<UserRow>();
  return res.results ?? [];
}

export async function findUser(db: D1Database, query: string): Promise<UserRow | null> {
  const trimmed = query.trim().replace(/^@/, '');
  if (/^\d+$/.test(trimmed)) {
    return getUser(db, Number(trimmed));
  }
  return db
    .prepare('SELECT * FROM users WHERE lower(username) = lower(?) ORDER BY updated_at DESC LIMIT 1')
    .bind(trimmed)
    .first<UserRow>();
}

export interface UserStats {
  total: number;
  allowed: number;
  approved: number;
  started: number;
  consented: number;
}

export async function getStats(db: D1Database): Promise<UserStats> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM users) AS total,
        (SELECT COUNT(*) FROM users WHERE can_receive_messages = 1 AND dm_status = 'allowed') AS allowed,
        (SELECT COUNT(*) FROM users WHERE approved_at IS NOT NULL) AS approved,
        (SELECT COUNT(*) FROM users WHERE started_at IS NOT NULL) AS started,
        (SELECT COUNT(*) FROM users WHERE consent_broadcasts = 1) AS consented`,
    )
    .first<Record<string, number>>();
  return {
    total: Number(row?.total ?? 0),
    allowed: Number(row?.allowed ?? 0),
    approved: Number(row?.approved ?? 0),
    started: Number(row?.started ?? 0),
    consented: Number(row?.consented ?? 0),
  };
}

// ---------------------------------------------------------------- links

export interface ChannelLink {
  id: number;
  slug: string;
  title: string;
  url: string;
  kind: string;
  active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export async function listLinks(db: D1Database, onlyActive = false): Promise<ChannelLink[]> {
  const sql = onlyActive
    ? 'SELECT * FROM channel_links WHERE active = 1 ORDER BY sort_order, id'
    : 'SELECT * FROM channel_links ORDER BY sort_order, id';
  const res = await db.prepare(sql).all<ChannelLink>();
  return res.results ?? [];
}

export async function getLink(db: D1Database, id: number): Promise<ChannelLink | null> {
  return db.prepare('SELECT * FROM channel_links WHERE id = ?').bind(id).first<ChannelLink>();
}

export async function getLinkBySlug(db: D1Database, slug: string): Promise<ChannelLink | null> {
  return db.prepare('SELECT * FROM channel_links WHERE slug = ?').bind(slug).first<ChannelLink>();
}

export async function createLink(
  db: D1Database,
  input: { slug: string; title: string; url: string; kind?: string },
): Promise<number> {
  const now = nowIso();
  const max = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM channel_links').first<{ m: number }>();
  const res = await db
    .prepare(
      `INSERT INTO channel_links (slug, title, url, kind, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .bind(input.slug, input.title, input.url, input.kind ?? 'extra', Number(max?.m ?? 0) + 1, now, now)
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

export async function updateLink(
  db: D1Database,
  id: number,
  patch: { slug?: string; title?: string; url?: string; kind?: string; active?: number },
): Promise<void> {
  const existing = await getLink(db, id);
  if (!existing) return;
  await db
    .prepare(
      `UPDATE channel_links SET slug = ?, title = ?, url = ?, kind = ?, active = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      patch.slug ?? existing.slug,
      patch.title ?? existing.title,
      patch.url ?? existing.url,
      patch.kind ?? existing.kind,
      patch.active ?? existing.active,
      nowIso(),
      id,
    )
    .run();
}

export async function deleteLink(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM channel_links WHERE id = ?').bind(id).run();
}

export interface LinkMap {
  [slug: string]: ChannelLink;
}

export async function getLinkMap(db: D1Database): Promise<LinkMap> {
  const links = await listLinks(db, true);
  const map: LinkMap = {};
  for (const link of links) map[link.slug] = link;
  return map;
}

/** Resolves stored buttons, including references to dynamic channel links. */
export function resolveStoredButtons(buttons: StoredButton[] | undefined, map: LinkMap): Array<{ text: string; url: string }> {
  if (!buttons) return [];
  const out: Array<{ text: string; url: string }> = [];
  for (const button of buttons) {
    let url = button.url ?? '';
    if (!url && button.link) {
      url = map[button.link]?.url ?? '';
    }
    if (button.text && url) out.push({ text: button.text, url });
  }
  return out;
}

/** Replaces {link:slug} placeholders with current channel URLs. */
export function resolveLinkPlaceholders(text: string | undefined, map: LinkMap): string {
  if (!text) return '';
  return text.replace(/\{link:([a-z0-9_-]{1,32})\}/gi, (_match, slug: string) => {
    return map[slug.toLowerCase()]?.url ?? '';
  });
}

// ---------------------------------------------------------------- sessions

export async function getSession(db: D1Database, adminId: number): Promise<AdminSession | null> {
  const row = await db
    .prepare('SELECT state, payload FROM admin_sessions WHERE admin_id = ?')
    .bind(adminId)
    .first<{ state: string; payload: string | null }>();
  if (!row) return null;
  let data: Record<string, unknown> = {};
  try {
    data = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }
  return { state: row.state, data };
}

export async function setSession(
  db: D1Database,
  adminId: number,
  session: AdminSession,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_sessions (admin_id, state, payload, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(admin_id) DO UPDATE SET state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at`,
    )
    .bind(adminId, session.state, JSON.stringify(session.data), nowIso())
    .run();
}

export async function clearSession(db: D1Database, adminId: number): Promise<void> {
  await db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').bind(adminId).run();
}

export async function cleanupSessions(db: D1Database, olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  await db.prepare('DELETE FROM admin_sessions WHERE updated_at < ?').bind(cutoff).run();
}

// ---------------------------------------------------------------- messages

export async function getMessageStatus(db: D1Database, dedupeKey: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT status FROM messages WHERE dedupe_key = ?')
    .bind(dedupeKey)
    .first<{ status: string }>();
  return row?.status ?? null;
}

export async function recordMessage(
  db: D1Database,
  input: {
    telegramId: number;
    dedupeKey: string;
    kind: 'welcome' | 'broadcast' | 'system';
    contentType: string;
    status: 'sent' | 'failed' | 'skipped';
    broadcastId?: number;
    errorCode?: number;
    errorDescription?: string;
  },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO messages
        (telegram_id, dedupe_key, direction, kind, broadcast_id, content_type, status, error_code, error_description, created_at, sent_at)
       VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         status = excluded.status,
         error_code = excluded.error_code,
         error_description = excluded.error_description,
         sent_at = excluded.sent_at`,
    )
    .bind(
      input.telegramId,
      input.dedupeKey,
      input.kind,
      input.broadcastId ?? null,
      input.contentType,
      input.status,
      input.errorCode ?? null,
      input.errorDescription ?? null,
      now,
      input.status === 'sent' ? now : null,
    )
    .run();
}

// ---------------------------------------------------------------- audience

export interface AudienceQuery {
  sql: string;
  params: Array<string | number>;
}

export function audienceWhere(segment: AudienceSegment, adminIds: number[]): AudienceQuery {
  switch (segment) {
    case 'started':
      return {
        sql: `started_at IS NOT NULL AND can_receive_messages = 1 AND dm_status = 'allowed'`,
        params: [],
      };
    case 'approved':
      return {
        sql: `approved_at IS NOT NULL AND can_receive_messages = 1 AND dm_status = 'allowed'`,
        params: [],
      };
    case 'consented':
      return {
        sql: `consent_broadcasts = 1 AND can_receive_messages = 1 AND dm_status = 'allowed'`,
        params: [],
      };
    case 'test': {
      if (!adminIds.length) return { sql: '0 = 1', params: [] };
      const placeholders = adminIds.map(() => '?').join(', ');
      return { sql: `telegram_id IN (${placeholders})`, params: [...adminIds] };
    }
    case 'all_allowed':
    default:
      return { sql: `can_receive_messages = 1 AND dm_status = 'allowed'`, params: [] };
  }
}

export async function countAudience(
  db: D1Database,
  segment: AudienceSegment,
  adminIds: number[],
): Promise<number> {
  const where = audienceWhere(segment, adminIds);
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM users WHERE ${where.sql}`)
    .bind(...where.params)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

export async function countAudienceWithoutConsent(
  db: D1Database,
  segment: AudienceSegment,
  adminIds: number[],
): Promise<number> {
  const where = audienceWhere(segment, adminIds);
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM users WHERE (${where.sql}) AND consent_broadcasts = 0`)
    .bind(...where.params)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

// ---------------------------------------------------------------- broadcasts

export interface BroadcastInput {
  adminId: number;
  name: string;
  contentType: 'text' | 'photo' | 'video';
  text: string | null;
  caption: string | null;
  fileId: string | null;
  parseMode: string | null;
  buttonsJson: string | null;
  audience: AudienceSegment;
  ratePerSec: number;
  adminIds: number[];
}

export async function createBroadcast(db: D1Database, input: BroadcastInput): Promise<number> {
  const now = nowIso();
  const res = await db
    .prepare(
      `INSERT INTO broadcasts
        (admin_id, name, content_type, text, caption, file_id, parse_mode, buttons_json, audience, status,
         rate_per_sec, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    )
    .bind(
      input.adminId,
      input.name,
      input.contentType,
      input.text,
      input.caption,
      input.fileId,
      input.parseMode,
      input.buttonsJson,
      input.audience,
      input.ratePerSec,
      now,
      now,
    )
    .run();

  const id = Number(res.meta.last_row_id ?? 0);
  const where = audienceWhere(input.audience, input.adminIds);
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO broadcast_recipients (broadcast_id, telegram_id, status, updated_at)
       SELECT ?, telegram_id, 'pending', ? FROM users WHERE ${where.sql}`,
    )
    .bind(id, now, ...where.params)
    .run();

  const total = Number(inserted.meta.changes ?? 0);
  await db
    .prepare(`UPDATE broadcasts SET total = ?, status = 'running', started_at = ?, updated_at = ? WHERE id = ?`)
    .bind(total, now, now, id)
    .run();
  return id;
}

export async function getBroadcast(db: D1Database, id: number): Promise<BroadcastRow | null> {
  return db.prepare('SELECT * FROM broadcasts WHERE id = ?').bind(id).first<BroadcastRow>();
}

export async function listBroadcasts(db: D1Database, limit = 10): Promise<BroadcastRow[]> {
  const res = await db
    .prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all<BroadcastRow>();
  return res.results ?? [];
}

export async function nextPendingRecipients(
  db: D1Database,
  broadcastId: number,
  cursor: number,
  limit: number,
): Promise<number[]> {
  const res = await db
    .prepare(
      `SELECT telegram_id FROM broadcast_recipients
       WHERE broadcast_id = ? AND status = 'pending' AND telegram_id > ?
       ORDER BY telegram_id LIMIT ?`,
    )
    .bind(broadcastId, cursor, limit)
    .all<{ telegram_id: number }>();
  return (res.results ?? []).map((r) => Number(r.telegram_id));
}

export async function claimRecipient(
  db: D1Database,
  broadcastId: number,
  telegramId: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE broadcast_recipients
       SET status = 'sending', attempts = attempts + 1, updated_at = ?
       WHERE broadcast_id = ? AND telegram_id = ? AND status = 'pending' AND attempts < 6
         AND EXISTS (SELECT 1 FROM broadcasts WHERE id = ? AND status = 'running')`,
    )
    .bind(nowIso(), broadcastId, telegramId, broadcastId)
    .run();
  return Number(res.meta.changes ?? 0) > 0;
}

export async function revertRecipient(
  db: D1Database,
  broadcastId: number,
  telegramId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE broadcast_recipients
       SET status = 'pending', attempts = MAX(0, attempts - 1), updated_at = ?
       WHERE broadcast_id = ? AND telegram_id = ? AND status = 'sending'`,
    )
    .bind(nowIso(), broadcastId, telegramId)
    .run();
}

export type RecipientStatus = 'sent' | 'failed' | 'blocked' | 'unreachable' | 'skipped';

const COUNTER_COLUMNS: Record<RecipientStatus, string> = {
  sent: 'sent',
  failed: 'failed',
  blocked: 'blocked',
  unreachable: 'unreachable',
  skipped: 'skipped',
};

export async function finishRecipient(
  db: D1Database,
  broadcastId: number,
  telegramId: number,
  status: RecipientStatus,
  errorCode?: number,
  errorDescription?: string,
): Promise<void> {
  const now = nowIso();
  const counter = COUNTER_COLUMNS[status];
  await db.batch([
    db
      .prepare(
        `UPDATE broadcast_recipients
         SET status = ?, error_code = ?, error_description = ?, sent_at = ?, updated_at = ?
         WHERE broadcast_id = ? AND telegram_id = ?`,
      )
      .bind(
        status,
        errorCode ?? null,
        errorDescription ?? null,
        status === 'sent' ? now : null,
        now,
        broadcastId,
        telegramId,
      ),
    db
      .prepare(
        `UPDATE broadcasts SET ${counter} = ${counter} + 1, updated_at = ?,
           last_error = CASE WHEN ? = 'failed' THEN ? ELSE last_error END
         WHERE id = ?`,
      )
      .bind(now, status, errorDescription ?? null, broadcastId),
  ]);
}

export async function markPendingFailed(
  db: D1Database,
  broadcastId: number,
  telegramId: number,
  reason: string,
): Promise<void> {
  await finishRecipient(db, broadcastId, telegramId, 'failed', undefined, reason);
}

export async function countPending(db: D1Database, broadcastId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM broadcast_recipients WHERE broadcast_id = ? AND status IN ('pending', 'sending')`,
    )
    .bind(broadcastId)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

export async function reconcileBroadcast(db: D1Database, broadcastId: number): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE broadcasts SET
         sent = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'sent'),
         failed = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'failed'),
         blocked = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'blocked'),
         unreachable = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'unreachable'),
         skipped = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'skipped'),
         updated_at = ?
       WHERE id = ?`,
    )
    .bind(broadcastId, broadcastId, broadcastId, broadcastId, broadcastId, now, broadcastId)
    .run();
}

export async function completeBroadcastIfDone(db: D1Database, broadcastId: number): Promise<boolean> {
  const pending = await countPending(db, broadcastId);
  if (pending > 0) return false;
  await reconcileBroadcast(db, broadcastId);
  await db
    .prepare(
      `UPDATE broadcasts SET status = 'completed', completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .bind(nowIso(), nowIso(), broadcastId)
    .run();
  return true;
}

export async function pauseBroadcast(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE broadcasts SET status = 'paused', paused_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
    )
    .bind(nowIso(), nowIso(), id)
    .run();
  return Number(res.meta.changes ?? 0) > 0;
}

export async function resumeBroadcast(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE broadcasts SET status = 'running', updated_at = ? WHERE id = ? AND status = 'paused'`)
    .bind(nowIso(), id)
    .run();
  return Number(res.meta.changes ?? 0) > 0;
}

export async function stopBroadcast(db: D1Database, id: number): Promise<boolean> {
  const now = nowIso();
  const res = await db
    .prepare(
      `UPDATE broadcasts SET status = 'stopped', completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('running', 'paused', 'draft')`,
    )
    .bind(now, now, id)
    .run();
  if (Number(res.meta.changes ?? 0) === 0) return false;
  await db
    .prepare(
      `UPDATE broadcast_recipients SET status = 'skipped', updated_at = ?
       WHERE broadcast_id = ? AND status IN ('pending', 'sending')`,
    )
    .bind(now, id)
    .run();
  await reconcileBroadcast(db, id);
  return true;
}

export async function cleanupStuckSending(db: D1Database): Promise<number[]> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const res = await db
    .prepare(
      `UPDATE broadcast_recipients
       SET status = 'failed', error_description = 'stuck sending after worker restart', updated_at = ?
       WHERE status = 'sending' AND updated_at < ?
       RETURNING broadcast_id`,
    )
    .bind(nowIso(), cutoff)
    .all<{ broadcast_id: number }>();
  const ids = new Set<number>();
  for (const row of res.results ?? []) ids.add(Number(row.broadcast_id));
  return [...ids];
}

export async function staleRunningBroadcasts(db: D1Database, staleMs = 2 * 60 * 1000): Promise<number[]> {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const res = await db
    .prepare(`SELECT id FROM broadcasts WHERE status = 'running' AND updated_at < ? ORDER BY id LIMIT 20`)
    .bind(cutoff)
    .all<{ id: number }>();
  return (res.results ?? []).map((r) => Number(r.id));
}

export async function broadcastRecipientBreakdown(
  db: D1Database,
  id: number,
): Promise<Array<{ status: string; c: number }>> {
  const res = await db
    .prepare('SELECT status, COUNT(*) AS c FROM broadcast_recipients WHERE broadcast_id = ? GROUP BY status')
    .bind(id)
    .all<{ status: string; c: number }>();
  return res.results ?? [];
}
