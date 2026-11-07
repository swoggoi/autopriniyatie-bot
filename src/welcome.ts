import type { Content, Env, QueueJob, ResolvedButton } from './types';
import {
  getLinkMap,
  getMessageStatus,
  getWelcomeConfig,
  recordMessage,
  resolveLinkPlaceholders,
  resolveStoredButtons,
  ensureUser,
  setDmStatus,
  getUser,
  nowIso,
} from './db';
import { classifyTelegramError, sendContent } from './telegram';

export interface WelcomeResult {
  status: 'sent' | 'skipped' | 'failed' | 'blocked' | 'unreachable' | 'retry';
  retryAfter?: number;
  description?: string;
}

export function buildWelcomeContent(
  config: Awaited<ReturnType<typeof getWelcomeConfig>>,
  linkMap: Awaited<ReturnType<typeof getLinkMap>>,
): { content: Content; buttons: ResolvedButton[] } {
  return {
    content: {
      contentType: config.contentType,
      text: resolveLinkPlaceholders(config.text, linkMap),
      caption: resolveLinkPlaceholders(config.caption, linkMap),
      fileId: config.fileId,
      parseMode: config.parseMode ?? null,
    },
    buttons: resolveStoredButtons(config.buttons, linkMap),
  };
}

function uniqueTargets(values: Array<number | undefined>): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (value && Number.isFinite(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * Sends the welcome message after a join request is approved.
 * Uses user_chat_id first (valid for a limited time after the request),
 * then falls back to the known private chat if the user started the bot.
 */
export async function processWelcomeJob(
  env: Env,
  job: Extract<QueueJob, { type: 'welcome' }>,
): Promise<WelcomeResult> {
  const token = env.MAIN_BOT_TOKEN || env.BOT_TOKEN || '';
  if (!token) return { status: 'failed', description: 'main bot token is not configured' };

  const previous = await getMessageStatus(env.DB, job.dedupeKey);
  if (previous === 'sent' || previous === 'skipped') {
    console.log(`WELCOME skipped duplicate user=${job.userId} key=${job.dedupeKey}`);
    return { status: 'skipped' };
  }

  const config = await getWelcomeConfig(env.DB);
  if (!config.enabled) {
    await recordMessage(env.DB, {
      telegramId: job.userId,
      dedupeKey: job.dedupeKey,
      kind: 'welcome',
      contentType: config.contentType,
      status: 'skipped',
      errorDescription: 'welcome disabled',
    });
    return { status: 'skipped', description: 'welcome disabled' };
  }

  const user = await getUser(env.DB, job.userId);
  const linkMap = await getLinkMap(env.DB);
  const { content, buttons } = buildWelcomeContent(config, linkMap);

  const targets = uniqueTargets([
    job.userChatId,
    user?.started_at ? job.userId : undefined,
    // If user_chat_id was not provided, a known private chat is still usable.
    !job.userChatId ? (user?.private_chat_id ?? undefined) : undefined,
  ]);

  if (!targets.length) {
    await recordMessage(env.DB, {
      telegramId: job.userId,
      dedupeKey: job.dedupeKey,
      kind: 'welcome',
      contentType: content.contentType,
      status: 'failed',
      errorDescription: 'no private chat target',
    });
    return { status: 'failed', description: 'no private chat target' };
  }

  let lastDescription = 'not sent';
  let lastCode: number | undefined;
  let lastStatus = 0;

  for (const target of targets) {
    const { result } = await sendContent(token, target, content, buttons, { retries: 0 });
    if (result.ok) {
      await ensureUser(env.DB, job.userId);
      await setDmStatus(env.DB, job.userId, 'allowed');
      await env.DB.prepare('UPDATE users SET private_chat_id = ?, updated_at = ? WHERE telegram_id = ?')
        .bind(target, nowIso(), job.userId)
        .run();
      await recordMessage(env.DB, {
        telegramId: job.userId,
        dedupeKey: job.dedupeKey,
        kind: 'welcome',
        contentType: content.contentType,
        status: 'sent',
      });
      console.log(`WELCOME sent user=${job.userId} chat=${target}`);
      return { status: 'sent' };
    }

    lastDescription = result.description ?? 'unknown error';
    lastCode = result.errorCode;
    lastStatus = result.status;

    if (result.status === 429) {
      console.warn(`WELCOME rate limited user=${job.userId} retry_after=${result.retryAfter ?? '?'}`);
      return { status: 'retry', retryAfter: result.retryAfter ?? 5, description: lastDescription };
    }

    if (result.network) {
      return { status: 'retry', retryAfter: 5, description: lastDescription };
    }
  }

  const kind = classifyTelegramError({
    ok: false,
    status: lastStatus,
    description: lastDescription,
    errorCode: lastCode,
  });
  const status = kind === 'blocked' ? 'blocked' : kind === 'unreachable' ? 'unreachable' : 'failed';
  if (status === 'blocked' || status === 'unreachable') {
    await ensureUser(env.DB, job.userId);
    await setDmStatus(env.DB, job.userId, status, lastDescription);
  }
  await recordMessage(env.DB, {
    telegramId: job.userId,
    dedupeKey: job.dedupeKey,
    kind: 'welcome',
    contentType: content.contentType,
    status: 'failed',
    errorCode: lastCode,
    errorDescription: lastDescription,
  });
  console.warn(`WELCOME failed user=${job.userId} status=${status} description=${lastDescription}`);
  return { status, description: lastDescription };
}
