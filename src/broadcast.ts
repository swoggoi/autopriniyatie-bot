import type { BroadcastRow, Content, Env, QueueJob, StoredButton } from './types';
import {
  cleanupSessions,
  cleanupStuckSending,
  claimRecipient,
  completeBroadcastIfDone,
  countPending,
  finishRecipient,
  getBroadcast,
  getLinkMap,
  getMessageStatus,
  getUser,
  markPendingFailed,
  nextPendingRecipients,
  recordMessage,
  resolveStoredButtons,
  revertRecipient,
  setDmStatus,
  staleRunningBroadcasts,
} from './db';
import { getMainToken } from './env';
import { classifyTelegramError, sendContent, sleep } from './telegram';
import { processWelcomeJob } from './welcome';

const BATCH_SIZE = 20;

function parseButtons(json: string | null | undefined): StoredButton[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredButton => {
      return Boolean(item && typeof item === 'object' && typeof (item as StoredButton).text === 'string');
    });
  } catch {
    return [];
  }
}

function broadcastContent(b: BroadcastRow): Content {
  return {
    contentType: b.content_type,
    text: b.text ?? '',
    caption: b.caption ?? '',
    fileId: b.file_id ?? undefined,
    parseMode: b.parse_mode,
  };
}

async function enqueueNext(env: Env, broadcastId: number, cursor: number, delaySeconds = 0): Promise<void> {
  await env.BROADCAST_QUEUE.send({ type: 'broadcast', broadcastId, cursor }, { delaySeconds });
}

async function processBroadcastJob(
  env: Env,
  broadcastId: number,
  cursor: number,
): Promise<{ retryAfter?: number }> {
  const token = getMainToken(env);
  if (!token) return {};

  let broadcast = await getBroadcast(env.DB, broadcastId);
  if (!broadcast) {
    console.warn(`BROADCAST ${broadcastId} not found`);
    return {};
  }
  if (broadcast.status !== 'running') {
    console.log(`BROADCAST ${broadcastId} skipped status=${broadcast.status}`);
    return {};
  }

  const recipients = await nextPendingRecipients(env.DB, broadcastId, cursor, BATCH_SIZE);
  if (!recipients.length) {
    await completeBroadcastIfDone(env.DB, broadcastId);
    return {};
  }

  const linkMap = await getLinkMap(env.DB);
  const buttons = resolveStoredButtons(parseButtons(broadcast.buttons_json), linkMap);
  const content = broadcastContent(broadcast);
  const rate = Math.max(1, Math.min(28, broadcast.rate_per_sec || 20));
  const delayMs = Math.ceil(1000 / rate);
  let last = cursor;

  for (let index = 0; index < recipients.length; index++) {
    const telegramId = recipients[index];

    // Re-read the status periodically and before every claim-sensitive step.
    if (index % 5 === 0) {
      broadcast = await getBroadcast(env.DB, broadcastId);
      if (!broadcast || broadcast.status !== 'running') {
        console.log(`BROADCAST ${broadcastId} stopped mid-batch status=${broadcast?.status ?? 'missing'}`);
        return {};
      }
    }

    const claimed = await claimRecipient(env.DB, broadcastId, telegramId);
    if (!claimed) {
      const stillPending = await env.DB
        .prepare(
          `SELECT attempts, status FROM broadcast_recipients
           WHERE broadcast_id = ? AND telegram_id = ?`,
        )
        .bind(broadcastId, telegramId)
        .first<{ attempts: number; status: string }>();
      if (stillPending?.status === 'pending' && Number(stillPending.attempts) >= 6) {
        await markPendingFailed(env.DB, broadcastId, telegramId, 'too many attempts');
      }
      last = telegramId;
      continue;
    }

    const user = await getUser(env.DB, telegramId);
    const chatId = user?.private_chat_id ?? telegramId;
    const dedupeKey = `broadcast:${broadcastId}:${telegramId}`;

    try {
      const { result } = await sendContent(token, chatId, content, buttons, { retries: 0 });

      if (result.ok) {
        await finishRecipient(env.DB, broadcastId, telegramId, 'sent');
        await recordMessage(env.DB, {
          telegramId,
          dedupeKey,
          kind: 'broadcast',
          contentType: content.contentType,
          status: 'sent',
          broadcastId,
        });
        await setDmStatus(env.DB, telegramId, 'allowed');
        last = telegramId;
      } else if (result.status === 429) {
        await revertRecipient(env.DB, broadcastId, telegramId);
        const retryAfter = Math.max(1, Math.min(3600, result.retryAfter ?? 5));
        console.warn(`BROADCAST ${broadcastId} rate limited retry_after=${retryAfter}`);
        return { retryAfter };
      } else {
        const kind = classifyTelegramError(result);
        if (kind === 'retryable') {
          await revertRecipient(env.DB, broadcastId, telegramId);
          console.warn(`BROADCAST ${broadcastId} transient failure user=${telegramId}: ${result.description ?? '?'}`);
          return { retryAfter: 5 };
        }

        const status = kind === 'blocked' ? 'blocked' : kind === 'unreachable' ? 'unreachable' : 'failed';
        await finishRecipient(env.DB, broadcastId, telegramId, status, result.errorCode, result.description);
        await recordMessage(env.DB, {
          telegramId,
          dedupeKey,
          kind: 'broadcast',
          contentType: content.contentType,
          status: 'failed',
          broadcastId,
          errorCode: result.errorCode,
          errorDescription: result.description,
        });
        if (status === 'blocked' || status === 'unreachable') {
          await setDmStatus(env.DB, telegramId, status, result.description);
        }
        last = telegramId;
      }
    } catch (err) {
      await revertRecipient(env.DB, broadcastId, telegramId);
      throw err;
    }

    if (index < recipients.length - 1) await sleep(delayMs);
  }

  const stillRunning = await getBroadcast(env.DB, broadcastId);
  if (!stillRunning || stillRunning.status !== 'running') return {};

  const done = await completeBroadcastIfDone(env.DB, broadcastId);
  if (!done) {
    const pending = await countPending(env.DB, broadcastId);
    if (pending > 0) {
      await enqueueNext(env, broadcastId, last);
    }
  }
  return {};
}

async function processKick(env: Env, broadcastId: number): Promise<{ retryAfter?: number }> {
  const broadcast = await getBroadcast(env.DB, broadcastId);
  if (!broadcast || broadcast.status !== 'running') return {};
  const pending = await countPending(env.DB, broadcastId);
  if (!pending) {
    await completeBroadcastIfDone(env.DB, broadcastId);
    return {};
  }
  await enqueueNext(env, broadcastId, 0);
  return {};
}

export async function handleQueue(
  batch: MessageBatch<QueueJob>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    console.log(`QUEUE job type=${job.type} attempts=${message.attempts}`);
    try {
      if (job.type === 'welcome') {
        const result = await processWelcomeJob(env, job);
        if (result.status === 'retry') {
          message.retry({ delaySeconds: Math.max(1, Math.min(3600, result.retryAfter ?? 5)) });
        } else {
          message.ack();
        }
        continue;
      }

      if (job.type === 'broadcast-kick') {
        const result = await processKick(env, job.broadcastId);
        if (result.retryAfter) message.retry({ delaySeconds: result.retryAfter });
        else message.ack();
        continue;
      }

      if (job.type === 'broadcast') {
        const result = await processBroadcastJob(env, job.broadcastId, job.cursor);
        if (result.retryAfter) message.retry({ delaySeconds: result.retryAfter });
        else message.ack();
        continue;
      }

      message.ack();
    } catch (err) {
      console.error(`QUEUE job failed type=${(job as QueueJob).type}`, err);
      message.retry({ delaySeconds: 10 });
    }
  }
}

export async function handleScheduled(env: Env, _event: ScheduledController, _ctx: ExecutionContext): Promise<void> {
  try {
    const stuckBroadcasts = await cleanupStuckSending(env.DB);
    for (const id of stuckBroadcasts) {
      await completeBroadcastIfDone(env.DB, id);
    }
    if (stuckBroadcasts.length) {
      console.log(`CRON cleaned stuck recipients for broadcasts=${stuckBroadcasts.join(',')}`);
    }
  } catch (err) {
    console.error('CRON stuck cleanup failed', err);
  }

  try {
    const stale = await staleRunningBroadcasts(env.DB);
    for (const id of stale) {
      const pending = await countPending(env.DB, id);
      if (pending > 0) {
        await env.BROADCAST_QUEUE.send({ type: 'broadcast-kick', broadcastId: id });
        console.log(`CRON kicked broadcast=${id} pending=${pending}`);
      } else {
        await completeBroadcastIfDone(env.DB, id);
      }
    }
  } catch (err) {
    console.error('CRON broadcast recovery failed', err);
  }

  try {
    await cleanupSessions(env.DB);
  } catch (err) {
    console.error('CRON session cleanup failed', err);
  }
}
