import type { Content, ResolvedButton, TelegramMessage } from './types';

export interface TgResult<T = unknown> {
  ok: boolean;
  status: number;
  result?: T;
  description?: string;
  errorCode?: number;
  retryAfter?: number;
  network?: boolean;
}

export interface TgCallOptions {
  /** Number of extra attempts for transient failures. */
  retries?: number;
  timeoutMs?: number;
  /** Wait internally on 429 when retry_after is small. */
  waitOn429?: boolean;
  maxWaitMs?: number;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 60_000))));

const TELEGRAM_TIMEOUT = 15_000;

/**
 * Calls a Telegram Bot API method. Never logs the token.
 */
export async function tgCall<T = unknown>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  opts: TgCallOptions = {},
): Promise<TgResult<T>> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? TELEGRAM_TIMEOUT;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TG_NETWORK method=${method} attempt=${attempt} message=${message}`);
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      return { ok: false, status: 0, description: `network: ${message}`, network: true };
    } finally {
      clearTimeout(timer);
    }

    let data: {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      data = { ok: false, description: `non-JSON response (HTTP ${res.status})` };
    }

    if (data.ok) {
      return { ok: true, status: res.status, result: data.result };
    }

    const retryAfter = data.parameters?.retry_after;
    const result: TgResult<T> = {
      ok: false,
      status: res.status,
      description: data.description ?? `HTTP ${res.status}`,
      errorCode: data.error_code,
      retryAfter,
    };

    if (res.status === 429) {
      if (opts.waitOn429 && retryAfter && retryAfter * 1000 <= (opts.maxWaitMs ?? 3000) && attempt < retries) {
        await sleep(retryAfter * 1000);
        continue;
      }
      return result;
    }

    if ((res.status >= 500 || res.status === 0) && attempt < retries) {
      await sleep(500 * 2 ** attempt);
      continue;
    }

    console.error(
      `TG_FAIL method=${method} http=${res.status} error_code=${data.error_code ?? '?'} description=${data.description ?? '?'}`,
    );
    return result;
  }

  return { ok: false, status: 0, description: 'exhausted retries' };
}

export function escapeHtml(value: string | number | undefined | null): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Splits long messages without breaking them into tiny pieces. */
export function splitMessage(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) parts.push(rest);
  return parts;
}

export function buildInlineKeyboard(
  buttons: ResolvedButton[] | undefined,
  perRow = 2,
): { inline_keyboard: Array<Array<{ text: string; url: string }>> } | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  const valid = buttons
    .filter((b) => b.text && b.url && /^(https?:\/\/|tg:\/\/)/i.test(b.url))
    .map((b) => ({ text: truncate(b.text, 64), url: b.url }))
    .slice(0, 12);
  if (!valid.length) return undefined;
  const rows: Array<Array<{ text: string; url: string }>> = [];
  for (let i = 0; i < valid.length; i += perRow) {
    rows.push(valid.slice(i, i + perRow));
  }
  return { inline_keyboard: rows };
}

export function buttonsToRows(buttons: Array<{ text: string; url?: string; link?: string }>): Array<Array<{ text: string; url: string }>> {
  const rows: Array<Array<{ text: string; url: string }>> = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(
      buttons.slice(i, i + 2).map((b) => ({
        text: truncate(b.text, 64),
        url: b.url ?? '',
      })),
    );
  }
  return rows;
}

export type TelegramErrorKind = 'blocked' | 'unreachable' | 'retryable' | 'fatal';

/**
 * Classifies Telegram send errors. A successful API response only confirms
 * delivery to Telegram, not that the user read the message.
 */
export function classifyTelegramError(res: TgResult): TelegramErrorKind {
  if (res.network) return 'retryable';
  if (res.status === 429) return 'retryable';
  if (res.status >= 500) return 'retryable';
  const description = (res.description ?? '').toLowerCase();
  if (
    description.includes('bot was blocked') ||
    description.includes('blocked by the user') ||
    description.includes('user is deactivated') ||
    description.includes('bot was kicked')
  ) {
    return res.errorCode === 400 ? 'unreachable' : 'blocked';
  }
  if (
    description.includes('chat not found') ||
    description.includes("bot can't initiate conversation") ||
    description.includes('peer_id_invalid') ||
    description.includes('user not found') ||
    description.includes('user_id_invalid')
  ) {
    return 'unreachable';
  }
  return 'fatal';
}

export function isBenignApprovalError(description: string | undefined): boolean {
  return /ALREADY_PARTICIPANT|USER_ALREADY_PARTICIPANT|CHAT_ADMIN_REQUIRED|TOPIC_CLOSED/i.test(
    description ?? '',
  );
}

export interface SendContentResult {
  result: TgResult<TelegramMessage>;
  messageIds: number[];
}

/**
 * Sends text, photo or video with optional inline URL buttons.
 * Long text is split; buttons are attached to the last text chunk.
 */
export async function sendContent(
  token: string,
  chatId: number | string,
  content: Content,
  buttons?: ResolvedButton[],
  opts: TgCallOptions = {},
): Promise<SendContentResult> {
  const replyMarkup = buildInlineKeyboard(buttons);
  const messageIds: number[] = [];

  if (content.contentType === 'photo' || content.contentType === 'video') {
    if (!content.fileId) {
      return {
        result: { ok: false, status: 0, description: 'media file_id is missing' },
        messageIds,
      };
    }
    const method = content.contentType === 'photo' ? 'sendPhoto' : 'sendVideo';
    const body: Record<string, unknown> = {
      chat_id: chatId,
      [content.contentType]: content.fileId,
    };
    if (content.caption) {
      body.caption = truncate(content.caption, 1024);
      if (content.parseMode) body.parse_mode = content.parseMode;
    }
    if (replyMarkup) body.reply_markup = replyMarkup;

    const result = await tgCall<TelegramMessage>(token, method, body, opts);
    if (result.ok && result.result?.message_id) messageIds.push(result.result.message_id);
    return { result, messageIds };
  }

  const text = content.text ?? '';
  if (!text.trim()) {
    return { result: { ok: false, status: 0, description: 'message text is empty' }, messageIds };
  }

  const chunks = splitMessage(text);
  let last: TgResult<TelegramMessage> = { ok: false, status: 0, description: 'not sent' };
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const body: Record<string, unknown> = { chat_id: chatId, text: chunks[i] };
    if (content.parseMode) body.parse_mode = content.parseMode;
    if (isLast && replyMarkup) body.reply_markup = replyMarkup;

    last = await tgCall<TelegramMessage>(token, 'sendMessage', body, opts);
    if (!last.ok) return { result: last, messageIds };
    if (last.result?.message_id) messageIds.push(last.result.message_id);
  }

  return { result: last, messageIds };
}

export async function sendText(
  token: string,
  chatId: number | string,
  text: string,
  keyboard?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> },
  parseMode: string | null = 'HTML',
  opts: TgCallOptions = {},
): Promise<TgResult<TelegramMessage>> {
  const body: Record<string, unknown> = { chat_id: chatId, text: truncate(text, 4096) };
  if (parseMode) body.parse_mode = parseMode;
  if (keyboard) body.reply_markup = keyboard;
  return tgCall<TelegramMessage>(token, 'sendMessage', body, opts);
}

export async function editText(
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> },
  parseMode: string | null = 'HTML',
): Promise<TgResult<TelegramMessage | boolean>> {
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text: truncate(text, 4096) };
  if (parseMode) body.parse_mode = parseMode;
  if (keyboard) body.reply_markup = keyboard;
  return tgCall<TelegramMessage | boolean>(token, 'editMessageText', body, { retries: 1 });
}

export async function answerCallback(
  token: string,
  callbackId: string,
  text?: string,
  showAlert = false,
): Promise<void> {
  await tgCall(token, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    text: text ? truncate(text, 200) : undefined,
    show_alert: showAlert,
  }, { retries: 1 });
}
