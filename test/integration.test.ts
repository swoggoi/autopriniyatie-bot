import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import {
  assertNoPendingInterceptors,
  installFetchMock,
  intercept,
  uninstallFetchMock,
} from './telegram-mock';
import type { QueueJob, TelegramUpdate } from '../src/types';
import {
  countAudience,
  countAudienceWithoutConsent,
  createBroadcast,
  createLink,
  deleteLink,
  getBroadcast,
  getLinkBySlug,
  getStats,
  getUser,
  getWelcomeConfig,
  listLinks,
  pauseBroadcast,
  resumeBroadcast,
  setWelcomeConfig,
  stopBroadcast,
  updateLink,
} from '../src/db';
import { handleQueue } from '../src/broadcast';
import { processWelcomeJob } from '../src/welcome';
import { DEFAULT_WELCOME } from '../src/defaults';

const MAIN_TOKEN = '8606393164:TEST';
const ADMIN_TOKEN = '9000398776:TEST';
const ADMIN_ID = 8406606797;
const CHANNEL_ID = '-1004416682870';
const SECOND_CHANNEL_ID = '-1004374130055';
const MAIN_SECRET = 'test-main-secret';
const ADMIN_SECRET = 'test-admin-secret';

let updateId = 1;

function nextUpdateId(): number {
  updateId += 1;
  return updateId;
}

async function postWebhook(path: string, body: unknown, secret: string): Promise<Response> {
  return SELF.fetch(`https://worker.example.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(body),
  });
}

function privateMessageUpdate(userId: number, text: string, firstName = 'Test'): TelegramUpdate {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private' },
      from: { id: userId, first_name: firstName, username: `user${userId}` },
      text,
    },
  };
}

function callbackUpdate(userId: number, data: string, messageId = 100): TelegramUpdate {
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: `cb-${nextUpdateId()}`,
      from: { id: userId, first_name: 'Admin', username: 'admin' },
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: 'private' },
      },
      data,
    },
  };
}

async function seedUser(
  id: number,
  opts: {
    started?: boolean;
    approved?: boolean;
    consent?: boolean;
    dm?: 'allowed' | 'blocked' | 'unreachable' | 'unknown';
    canReceive?: boolean;
  } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const dm = opts.dm ?? 'allowed';
  const canReceive = opts.canReceive ?? (dm === 'allowed' ? 1 : 0);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO users
      (telegram_id, username, first_name, last_name, private_chat_id, dm_status, can_receive_messages,
       started_at, first_seen_at, join_requested_at, approved_at, consent_broadcasts, consent_at, consent_source,
       last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      `user${id}`,
      `User${id}`,
      null,
      id,
      dm,
      canReceive,
      opts.started ? now : null,
      now,
      opts.approved ? now : null,
      opts.approved ? now : null,
      opts.consent ? 1 : 0,
      opts.consent ? now : null,
      opts.consent ? 'test' : null,
      null,
      now,
      now,
    )
    .run();
}

interface FakeBatch {
  batch: MessageBatch<QueueJob>;
  acks: number;
  retries: number;
}

function fakeQueueBatch(body: QueueJob): FakeBatch {
  const state: FakeBatch = {
    acks: 0,
    retries: 0,
    batch: undefined as unknown as MessageBatch<QueueJob>,
  };
  const message = {
    id: '1',
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: () => {
      state.acks += 1;
    },
    retry: () => {
      state.retries += 1;
    },
  };
  state.batch = {
    queue: 'autopriniyatie-broadcasts',
    messages: [message],
  } as unknown as MessageBatch<QueueJob>;
  return state;
}

beforeAll(async () => {
  installFetchMock();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM broadcast_recipients'),
    env.DB.prepare('DELETE FROM broadcasts'),
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM channel_members'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare('DELETE FROM admin_sessions'),
    env.DB.prepare('DELETE FROM channel_links'),
    env.DB.prepare('DELETE FROM settings'),
    env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('welcome', ?, ?)`)
      .bind(JSON.stringify(DEFAULT_WELCOME), new Date().toISOString()),
    env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('broadcast_rate', '20', ?)`)
      .bind(new Date().toISOString()),
  ]);
});

afterEach(() => {
  assertNoPendingInterceptors();
});

afterAll(() => {
  uninstallFetchMock();
});

describe('HTTP layer', () => {
  it('serves health without leaking tokens', async () => {
    const res = await SELF.fetch('https://worker.example.com/health');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('autopriniyatie-bot');
    expect(body).not.toContain('TEST');
  });

  it('rejects webhook requests with a bad secret', async () => {
    const main = await postWebhook('/webhook', privateMessageUpdate(1, '/start'), 'wrong');
    expect(main.status).toBe(403);
    const admin = await postWebhook('/admin/webhook', privateMessageUpdate(ADMIN_ID, '/start'), 'wrong');
    expect(admin.status).toBe(403);
    const diag = await SELF.fetch('https://worker.example.com/diagnose');
    expect(diag.status).toBe(403);
  });

  it('registers a user via /start and marks the private chat reachable', async () => {
    intercept(MAIN_TOKEN, 'sendMessage', 1);
    const res = await postWebhook('/webhook', privateMessageUpdate(111, '/start'), MAIN_SECRET);
    expect(res.status).toBe(200);

    const user = await getUser(env.DB, 111);
    expect(user?.started_at).toBeTruthy();
    expect(user?.can_receive_messages).toBe(1);
    expect(user?.dm_status).toBe('allowed');
  });

  it('approves a join request and records the approval', async () => {
    intercept(MAIN_TOKEN, 'approveChatJoinRequest', 1, { data: { ok: true, result: true } });
    const update: TelegramUpdate = {
      update_id: nextUpdateId(),
      chat_join_request: {
        chat: { id: Number(CHANNEL_ID), type: 'channel', title: 'Test channel' },
        from: { id: 222, first_name: 'Join', username: 'join222' },
        user_chat_id: 222,
        date: Math.floor(Date.now() / 1000),
      },
    };
    const res = await postWebhook('/webhook', update, MAIN_SECRET);
    expect(res.status).toBe(200);

    const user = await getUser(env.DB, 222);
    expect(user?.approved_at).toBeTruthy();
    expect(user?.join_requested_at).toBeTruthy();
    expect(user?.private_chat_id).toBe(222);
  });

  it('approves join requests from every configured channel', async () => {
    intercept(MAIN_TOKEN, 'approveChatJoinRequest', 1, { data: { ok: true, result: true } });
    const date = Math.floor(Date.now() / 1000);
    const update: TelegramUpdate = {
      update_id: nextUpdateId(),
      chat_join_request: {
        chat: { id: Number(SECOND_CHANNEL_ID), type: 'channel', title: 'Second channel' },
        from: { id: 223, first_name: 'Second', username: 'second223' },
        user_chat_id: 223,
        date,
      },
    };
    const res = await postWebhook('/webhook', update, MAIN_SECRET);
    expect(res.status).toBe(200);

    const user = await getUser(env.DB, 223);
    expect(user?.approved_at).toBeTruthy();
    expect(user?.source_channel_id).toBe(Number(SECOND_CHANNEL_ID));

    const membership = await env.DB.prepare(
      'SELECT status, joined_at FROM channel_members WHERE channel_id = ? AND telegram_id = ?',
    )
      .bind(Number(SECOND_CHANNEL_ID), 223)
      .first<{ status: string; joined_at: string | null }>();
    expect(membership?.status).toBe('member');
    expect(membership?.joined_at).toBeTruthy();
  });

  it('ignores join requests from channels that are not configured', async () => {
    const update: TelegramUpdate = {
      update_id: nextUpdateId(),
      chat_join_request: {
        chat: { id: -1009999999999, type: 'channel', title: 'Other channel' },
        from: { id: 224, first_name: 'Other', username: 'other224' },
        user_chat_id: 224,
        date: Math.floor(Date.now() / 1000),
      },
    };
    const res = await postWebhook('/webhook', update, MAIN_SECRET);
    expect(res.status).toBe(200);
    expect(await getUser(env.DB, 224)).toBeNull();
  });

  it('records channel membership from chat_member updates without marking DMs reachable', async () => {
    const date = Math.floor(Date.now() / 1000);
    const update: TelegramUpdate = {
      update_id: nextUpdateId(),
      chat_member: {
        chat: { id: Number(SECOND_CHANNEL_ID), type: 'channel', title: 'Second channel' },
        from: { id: 225, first_name: 'Member', username: 'member225' },
        date,
        old_chat_member: { status: 'left' },
        new_chat_member: {
          status: 'member',
          user: { id: 225, first_name: 'Member', username: 'member225' },
        },
      },
    };
    const res = await postWebhook('/webhook', update, MAIN_SECRET);
    expect(res.status).toBe(200);

    const user = await getUser(env.DB, 225);
    expect(user?.source_channel_id).toBe(Number(SECOND_CHANNEL_ID));
    expect(user?.can_receive_messages).toBe(0);

    const membership = await env.DB.prepare(
      'SELECT status FROM channel_members WHERE channel_id = ? AND telegram_id = ?',
    )
      .bind(Number(SECOND_CHANNEL_ID), 225)
      .first<{ status: string }>();
    expect(membership?.status).toBe('member');
  });

  it('denies non-admin users of the admin bot', async () => {
    intercept(ADMIN_TOKEN, 'sendMessage', 1);
    const res = await postWebhook('/admin/webhook', privateMessageUpdate(999, '/start'), ADMIN_SECRET);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM admin_sessions').first<{ c: number }>();
    expect(row?.c).toBe(0);
  });

  it('opens the admin menu for an allowed admin', async () => {
    intercept(ADMIN_TOKEN, 'sendMessage', 1);
    const res = await postWebhook('/admin/webhook', privateMessageUpdate(ADMIN_ID, '/start'), ADMIN_SECRET);
    expect(res.status).toBe(200);
  });

  it('renders statistics for an allowed admin', async () => {
    intercept(ADMIN_TOKEN, 'sendMessage', 1);
    const res = await postWebhook('/admin/webhook', privateMessageUpdate(ADMIN_ID, '/stats'), ADMIN_SECRET);
    expect(res.status).toBe(200);
  });
});

describe('welcome delivery', () => {
  it('sends the welcome via user_chat_id and de-duplicates the job', async () => {
    intercept(MAIN_TOKEN, 'sendMessage', 1);
    const job = {
      type: 'welcome' as const,
      chatId: CHANNEL_ID,
      userId: 301,
      userChatId: 301,
      requestDate: Math.floor(Date.now() / 1000),
      dedupeKey: 'welcome:test:301:1',
    };
    const first = await processWelcomeJob(env, job);
    expect(first.status).toBe('sent');

    const user = await getUser(env.DB, 301);
    expect(user?.dm_status).toBe('allowed');
    expect(user?.can_receive_messages).toBe(1);

    const message = await env.DB.prepare('SELECT status FROM messages WHERE dedupe_key = ?')
      .bind(job.dedupeKey)
      .first<{ status: string }>();
    expect(message?.status).toBe('sent');

    const second = await processWelcomeJob(env, job);
    expect(second.status).toBe('skipped');
  });

  it('marks users who blocked the bot as unreachable for broadcasts', async () => {
    intercept(MAIN_TOKEN, 'sendMessage', 1, {
      status: 403,
      data: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    });
    const result = await processWelcomeJob(env, {
      type: 'welcome',
      chatId: CHANNEL_ID,
      userId: 302,
      userChatId: 302,
      requestDate: Math.floor(Date.now() / 1000),
      dedupeKey: 'welcome:test:302:1',
    });
    expect(result.status).toBe('blocked');

    const user = await getUser(env.DB, 302);
    expect(user?.dm_status).toBe('blocked');
    expect(user?.can_receive_messages).toBe(0);
  });

  it('uses the configured welcome text and link placeholders', async () => {
    await createLink(env.DB, { slug: 'main', title: 'Main', url: 'https://t.me/main' });
    const config = await getWelcomeConfig(env.DB);
    await setWelcomeConfig(env.DB, { ...config, text: 'Привет {link:main}' });

    intercept(MAIN_TOKEN, 'sendMessage', 1);
    const result = await processWelcomeJob(env, {
      type: 'welcome',
      chatId: CHANNEL_ID,
      userId: 303,
      userChatId: 303,
      requestDate: Math.floor(Date.now() / 1000),
      dedupeKey: 'welcome:test:303:1',
    });
    expect(result.status).toBe('sent');
  });
});

describe('audience segmentation', () => {
  it('keeps segments separate', async () => {
    await seedUser(ADMIN_ID, { started: true, consent: true });
    await seedUser(401, { started: true, approved: true, consent: true });
    await seedUser(402, { approved: true });
    await seedUser(403, { consent: true, dm: 'blocked', canReceive: false });
    await seedUser(404, { started: true });

    const stats = await getStats(env.DB);
    expect(stats.total).toBe(5);
    expect(stats.allowed).toBe(4);
    expect(stats.started).toBe(3);
    expect(stats.approved).toBe(2);
    expect(stats.consented).toBe(3);

    expect(await countAudience(env.DB, 'all_allowed', [ADMIN_ID])).toBe(4);
    expect(await countAudience(env.DB, 'started', [ADMIN_ID])).toBe(3);
    expect(await countAudience(env.DB, 'approved', [ADMIN_ID])).toBe(2);
    expect(await countAudience(env.DB, 'consented', [ADMIN_ID])).toBe(2);
    expect(await countAudience(env.DB, 'test', [ADMIN_ID])).toBe(1);
    expect(await countAudienceWithoutConsent(env.DB, 'all_allowed', [ADMIN_ID])).toBe(2);
  });
});

describe('broadcast engine', () => {
  it('sends a text broadcast to the consented segment exactly once', async () => {
    await seedUser(501, { consent: true });
    await seedUser(502, { consent: false });
    const id = await createBroadcast(env.DB, {
      adminId: ADMIN_ID,
      name: 'Text test',
      contentType: 'text',
      text: 'Hello',
      caption: null,
      fileId: null,
      parseMode: 'HTML',
      buttonsJson: null,
      audience: 'consented',
      ratePerSec: 28,
      adminIds: [ADMIN_ID],
    });

    let broadcast = await getBroadcast(env.DB, id);
    expect(broadcast?.total).toBe(1);

    intercept(MAIN_TOKEN, 'sendMessage', 1);
    const state = fakeQueueBatch({ type: 'broadcast', broadcastId: id, cursor: 0 });
    await handleQueue(state.batch, env, {} as ExecutionContext);
    expect(state.acks).toBe(1);

    broadcast = await getBroadcast(env.DB, id);
    expect(broadcast?.status).toBe('completed');
    expect(broadcast?.sent).toBe(1);
    expect(broadcast?.failed).toBe(0);

    const message = await env.DB.prepare('SELECT status FROM messages WHERE dedupe_key = ?')
      .bind(`broadcast:${id}:501`)
      .first<{ status: string }>();
    expect(message?.status).toBe('sent');

    // Re-processing must not send again.
    const second = fakeQueueBatch({ type: 'broadcast', broadcastId: id, cursor: 0 });
    await handleQueue(second.batch, env, {} as ExecutionContext);
    const again = await getBroadcast(env.DB, id);
    expect(again?.sent).toBe(1);
  });

  it('sends a photo broadcast with dynamic link buttons', async () => {
    await seedUser(601, { consent: true });
    await createLink(env.DB, { slug: 'main', title: 'Main', url: 'https://t.me/main' });
    const id = await createBroadcast(env.DB, {
      adminId: ADMIN_ID,
      name: 'Photo test',
      contentType: 'photo',
      text: null,
      caption: 'Photo caption',
      fileId: 'PHOTO_FILE_ID',
      parseMode: 'HTML',
      buttonsJson: JSON.stringify([
        { text: 'Main', link: 'main' },
        { text: 'Site', url: 'https://example.com' },
      ]),
      audience: 'consented',
      ratePerSec: 28,
      adminIds: [ADMIN_ID],
    });

    intercept(MAIN_TOKEN, 'sendPhoto', 1);
    await handleQueue(fakeQueueBatch({ type: 'broadcast', broadcastId: id, cursor: 0 }).batch, env, {} as ExecutionContext);

    const broadcast = await getBroadcast(env.DB, id);
    expect(broadcast?.status).toBe('completed');
    expect(broadcast?.sent).toBe(1);
    const message = await env.DB.prepare('SELECT content_type FROM messages WHERE dedupe_key = ?')
      .bind(`broadcast:${id}:601`)
      .first<{ content_type: string }>();
    expect(message?.content_type).toBe('photo');
  });

  it('sends a video broadcast', async () => {
    await seedUser(602, { consent: true });
    const id = await createBroadcast(env.DB, {
      adminId: ADMIN_ID,
      name: 'Video test',
      contentType: 'video',
      text: null,
      caption: 'Video caption',
      fileId: 'VIDEO_FILE_ID',
      parseMode: 'HTML',
      buttonsJson: null,
      audience: 'consented',
      ratePerSec: 28,
      adminIds: [ADMIN_ID],
    });

    intercept(MAIN_TOKEN, 'sendVideo', 1);
    await handleQueue(fakeQueueBatch({ type: 'broadcast', broadcastId: id, cursor: 0 }).batch, env, {} as ExecutionContext);

    const broadcast = await getBroadcast(env.DB, id);
    expect(broadcast?.status).toBe('completed');
    expect(broadcast?.sent).toBe(1);
  });

  it('records blocked users separately', async () => {
    await seedUser(701, { consent: true });
    const id = await createBroadcast(env.DB, {
      adminId: ADMIN_ID,
      name: 'Blocked test',
      contentType: 'text',
      text: 'Hello',
      caption: null,
      fileId: null,
      parseMode: null,
      buttonsJson: null,
      audience: 'consented',
      ratePerSec: 28,
      adminIds: [ADMIN_ID],
    });

    intercept(MAIN_TOKEN, 'sendMessage', 1, {
      status: 403,
      data: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    });
    await handleQueue(fakeQueueBatch({ type: 'broadcast', broadcastId: id, cursor: 0 }).batch, env, {} as ExecutionContext);

    const broadcast = await getBroadcast(env.DB, id);
    expect(broadcast?.blocked).toBe(1);
    expect(broadcast?.sent).toBe(0);
    const user = await getUser(env.DB, 701);
    expect(user?.dm_status).toBe('blocked');
    expect(user?.can_receive_messages).toBe(0);
  });

  it('records unreachable users separately', async () => {
    await seedUser(702, { consent: true });
    const id = await createBroadcast(env.DB, {
      adminId: ADMIN_ID,
      name: 'Unreachable test',
      contentType: 'text',
      text: 'Hello',
      caption: null,
      fileId: null,
      parseMode: null,
      buttonsJson: null,
      audience: 'consented',
      ratePerSec: 28,
      adminIds: [ADMIN_ID],
    });

    intercept(MAIN_TOKEN, 'sendMessage', 1, {
      status: 400,
      data: { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
    });
    await handleQueue(fakeQueueBatch({ type: 'broadcast', broadcastId: id, cursor: 0 }).batch, env, {} as ExecutionContext);

    const broadcast = await getBroadcast(env.DB, id);
    expect(broadcast?.unreachable).toBe(1);
    const user = await getUser(env.DB, 702);
    expect(user?.dm_status).toBe('unreachable');
  });

  it('pauses, resumes and stops broadcasts', async () => {
    await seedUser(801, { consent: true });
    await seedUser(802, { consent: true });
    const id = await createBroadcast(env.DB, {
      adminId: ADMIN_ID,
      name: 'Pause test',
      contentType: 'text',
      text: 'Hello',
      caption: null,
      fileId: null,
      parseMode: null,
      buttonsJson: null,
      audience: 'consented',
      ratePerSec: 28,
      adminIds: [ADMIN_ID],
    });

    expect(await pauseBroadcast(env.DB, id)).toBe(true);
    await handleQueue(fakeQueueBatch({ type: 'broadcast', broadcastId: id, cursor: 0 }).batch, env, {} as ExecutionContext);
    let broadcast = await getBroadcast(env.DB, id);
    expect(broadcast?.status).toBe('paused');
    expect(broadcast?.sent).toBe(0);

    expect(await resumeBroadcast(env.DB, id)).toBe(true);
    intercept(MAIN_TOKEN, 'sendMessage', 2);
    await handleQueue(fakeQueueBatch({ type: 'broadcast', broadcastId: id, cursor: 0 }).batch, env, {} as ExecutionContext);
    broadcast = await getBroadcast(env.DB, id);
    expect(broadcast?.status).toBe('completed');
    expect(broadcast?.sent).toBe(2);

    await seedUser(803, { consent: true });
    const stoppedId = await createBroadcast(env.DB, {
      adminId: ADMIN_ID,
      name: 'Stop test',
      contentType: 'text',
      text: 'Hello',
      caption: null,
      fileId: null,
      parseMode: null,
      buttonsJson: null,
      audience: 'consented',
      ratePerSec: 28,
      adminIds: [ADMIN_ID],
    });
    expect(await stopBroadcast(env.DB, stoppedId)).toBe(true);
    const stopped = await getBroadcast(env.DB, stoppedId);
    expect(stopped?.status).toBe('stopped');
    expect(stopped?.skipped).toBeGreaterThan(0);
  });
});

describe('channel links CRUD', () => {
  it('creates, updates, toggles and deletes links', async () => {
    const id = await createLink(env.DB, { slug: 'extra', title: 'Extra', url: 'https://t.me/extra' });
    let link = await getLinkBySlug(env.DB, 'extra');
    expect(link?.title).toBe('Extra');

    await updateLink(env.DB, id, { title: 'Extra 2', url: 'https://t.me/extra2', active: 0 });
    link = await getLinkBySlug(env.DB, 'extra');
    expect(link?.title).toBe('Extra 2');
    expect(link?.url).toBe('https://t.me/extra2');
    expect(link?.active).toBe(0);

    const all = await listLinks(env.DB);
    expect(all).toHaveLength(1);

    await deleteLink(env.DB, id);
    expect(await getLinkBySlug(env.DB, 'extra')).toBeNull();
  });
});

describe('admin broadcast composer end-to-end', () => {
  it('walks through text broadcast creation and sends it', async () => {
    await seedUser(ADMIN_ID, { started: true, consent: true });

    intercept(ADMIN_TOKEN, 'answerCallbackQuery', 6, { data: { ok: true, result: true } });
    intercept(ADMIN_TOKEN, 'sendMessage', 4);
    intercept(ADMIN_TOKEN, 'editMessageText', 4);

    await postWebhook('/admin/webhook', callbackUpdate(ADMIN_ID, 'menu:bc_new'), ADMIN_SECRET);
    await postWebhook('/admin/webhook', callbackUpdate(ADMIN_ID, 'bc:type:text'), ADMIN_SECRET);
    await postWebhook('/admin/webhook', privateMessageUpdate(ADMIN_ID, 'Тестовая рассылка'), ADMIN_SECRET);
    await postWebhook('/admin/webhook', callbackUpdate(ADMIN_ID, 'bc:fmt:HTML'), ADMIN_SECRET);
    await postWebhook('/admin/webhook', callbackUpdate(ADMIN_ID, 'bc:btn:done'), ADMIN_SECRET);
    await postWebhook('/admin/webhook', callbackUpdate(ADMIN_ID, 'bc:aud:test'), ADMIN_SECRET);
    await postWebhook('/admin/webhook', callbackUpdate(ADMIN_ID, 'bc:go'), ADMIN_SECRET);

    const broadcast = await env.DB.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1').first<{
      id: number;
      status: string;
      audience: string;
      total: number;
    }>();
    expect(broadcast).toBeTruthy();
    expect(broadcast?.audience).toBe('test');
    expect(broadcast?.total).toBe(1);
    expect(broadcast?.status).toBe('running');

    intercept(MAIN_TOKEN, 'sendMessage', 1);
    await handleQueue(
      fakeQueueBatch({ type: 'broadcast', broadcastId: Number(broadcast?.id), cursor: 0 }).batch,
      env,
      {} as ExecutionContext,
    );
    const done = await getBroadcast(env.DB, Number(broadcast?.id));
    expect(done?.status).toBe('completed');
    expect(done?.sent).toBe(1);
  });
});
