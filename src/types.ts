export interface Env {
  /** New main bot token (preferred). */
  MAIN_BOT_TOKEN?: string;
  /** Legacy name for the main bot token, kept for backward compatibility. */
  BOT_TOKEN?: string;
  ADMIN_BOT_TOKEN?: string;
  /** Comma-separated list of Telegram user IDs allowed to use the admin bot. */
  ADMIN_IDS?: string;
  /** Legacy single-admin variable. */
  ADMIN_ID?: string;
  CHANNEL_ID: string;
  BOT_KV?: KVNamespace;
  DB: D1Database;
  BROADCAST_QUEUE: Queue<QueueJob>;
  WEBHOOK_SECRET?: string;
  ADMIN_WEBHOOK_SECRET?: string;
  DIAG_KEY?: string;
}

export type ContentType = 'text' | 'photo' | 'video';

export type StoredButton = {
  text: string;
  url?: string;
  /** Reference to channel_links.slug, resolved at send time. */
  link?: string;
};

export type ResolvedButton = {
  text: string;
  url: string;
};

export interface Content {
  contentType: ContentType;
  text?: string;
  caption?: string;
  fileId?: string;
  parseMode?: string | null;
  buttons?: StoredButton[];
}

export interface WelcomeConfig extends Content {
  enabled: boolean;
}

export type AudienceSegment =
  | 'all_allowed'
  | 'started'
  | 'approved'
  | 'consented'
  | 'test';

export interface BroadcastRow {
  id: number;
  admin_id: number;
  name: string;
  content_type: ContentType;
  text: string | null;
  caption: string | null;
  file_id: string | null;
  parse_mode: string | null;
  buttons_json: string | null;
  audience: AudienceSegment;
  status: string;
  total: number;
  sent: number;
  failed: number;
  blocked: number;
  unreachable: number;
  skipped: number;
  cursor: number | null;
  rate_per_sec: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export type QueueJob =
  | {
      type: 'welcome';
      chatId: string;
      userId: number;
      userChatId?: number;
      requestDate: number;
      dedupeKey: string;
    }
  | { type: 'broadcast'; broadcastId: number; cursor: number }
  | { type: 'broadcast-kick'; broadcastId: number };

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_unique_id?: string; width?: number; height?: number }>;
  video?: { file_id: string; file_unique_id?: string; duration?: number };
  document?: { file_id: string; file_name?: string };
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  chat_join_request?: {
    chat: TelegramChat;
    from: TelegramUser;
    user_chat_id?: number;
    date: number;
    invite_link?: { invite_link?: string };
  };
  my_chat_member?: {
    chat: TelegramChat;
    from: TelegramUser;
    date: number;
    old_chat_member?: { status: string };
    new_chat_member?: { status: string };
  };
}

export interface AdminSession {
  state: string;
  data: Record<string, unknown>;
}

export const SEGMENT_LABELS: Record<AudienceSegment, string> = {
  all_allowed: 'Все с разрешённой отправкой',
  started: 'Запускали основного бота',
  approved: 'Одобренные в канал',
  consented: 'Согласившиеся на рассылки',
  test: 'Тестовая аудитория (админы)',
};

export const PARSE_MODES = ['HTML', 'MarkdownV2'] as const;
