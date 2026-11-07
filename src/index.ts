import type { Env, QueueJob, TelegramUpdate } from './types';
import { handleMainUpdate } from './main-bot';
import { handleAdminUpdate } from './admin-bot';
import { handleQueue, handleScheduled } from './broadcast';
import { checkSecret, getAdminIds, getAdminToken, getChannelIds, getMainToken } from './env';
import { tgCall } from './telegram';
import { getStats } from './db';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const text = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

async function readUpdate(request: Request): Promise<TelegramUpdate | null> {
  try {
    return (await request.json()) as TelegramUpdate;
  } catch {
    return null;
  }
}

async function runDiagnostics(env: Env): Promise<Record<string, unknown>> {
  const mainToken = getMainToken(env);
  const adminToken = getAdminToken(env);
  const out: Record<string, unknown> = {
    ok: Boolean(mainToken && adminToken && env.DB && env.BROADCAST_QUEUE),
    hasMainToken: Boolean(mainToken),
    hasAdminToken: Boolean(adminToken),
    channelId: env.CHANNEL_ID,
    channelIds: getChannelIds(env),
    adminIds: getAdminIds(env),
    checks: {},
  };
  const checks = out.checks as Record<string, unknown>;

  const mainMe = await tgCall(mainToken, 'getMe');
  checks.mainGetMe = mainMe.ok
    ? { ok: true, id: (mainMe.result as { id?: number })?.id, username: (mainMe.result as { username?: string })?.username }
    : { ok: false, http: mainMe.status, description: mainMe.description };

  const adminMe = await tgCall(adminToken, 'getMe');
  checks.adminGetMe = adminMe.ok
    ? { ok: true, id: (adminMe.result as { id?: number })?.id, username: (adminMe.result as { username?: string })?.username }
    : { ok: false, http: adminMe.status, description: adminMe.description };

  const mainWebhook = await tgCall(mainToken, 'getWebhookInfo');
  checks.mainWebhook = mainWebhook.ok
    ? {
        ok: true,
        url: (mainWebhook.result as Record<string, unknown>)?.url,
        pending_update_count: (mainWebhook.result as Record<string, unknown>)?.pending_update_count,
        last_error_message: (mainWebhook.result as Record<string, unknown>)?.last_error_message ?? null,
      }
    : { ok: false, http: mainWebhook.status, description: mainWebhook.description };

  const adminWebhook = await tgCall(adminToken, 'getWebhookInfo');
  checks.adminWebhook = adminWebhook.ok
    ? {
        ok: true,
        url: (adminWebhook.result as Record<string, unknown>)?.url,
        pending_update_count: (adminWebhook.result as Record<string, unknown>)?.pending_update_count,
        last_error_message: (adminWebhook.result as Record<string, unknown>)?.last_error_message ?? null,
      }
    : { ok: false, http: adminWebhook.status, description: adminWebhook.description };

  const botId = mainMe.ok ? (mainMe.result as { id?: number })?.id : undefined;
  const channelChecks: Record<string, unknown> = {};
  for (const channelId of getChannelIds(env)) {
    const chat = await tgCall(mainToken, 'getChat', { chat_id: channelId });
    const item: Record<string, unknown> = chat.ok
      ? { ok: true, id: (chat.result as { id?: number })?.id, title: (chat.result as { title?: string })?.title }
      : { ok: false, http: chat.status, description: chat.description };
    if (botId) {
      const member = await tgCall(mainToken, 'getChatMember', {
        chat_id: channelId,
        user_id: botId,
      });
      item.botMembership = member.ok
        ? { ok: true, status: (member.result as { status?: string })?.status }
        : { ok: false, http: member.status, description: member.description };
      const count = await tgCall(mainToken, 'getChatMemberCount', { chat_id: channelId });
      item.memberCount = count.ok ? count.result : null;
    }
    channelChecks[channelId] = item;
  }
  checks.channels = channelChecks;

  try {
    checks.stats = await getStats(env.DB);
  } catch (err) {
    checks.stats = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    await env.BOT_KV?.put('diag:probe', String(Date.now()), { expirationTtl: 60 });
    checks.kv = { ok: Boolean(env.BOT_KV) };
  } catch (err) {
    checks.kv = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  checks.queue = { ok: Boolean(env.BROADCAST_QUEUE) };
  checks.secrets = {
    mainWebhookSecret: Boolean(env.WEBHOOK_SECRET),
    adminWebhookSecret: Boolean(env.ADMIN_WEBHOOK_SECRET),
  };

  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({
        service: 'autopriniyatie-bot',
        ok: true,
        hasMainToken: Boolean(getMainToken(env)),
        hasAdminToken: Boolean(getAdminToken(env)),
        channelId: env.CHANNEL_ID,
        channelIds: getChannelIds(env),
        kvBound: Boolean(env.BOT_KV),
        dbBound: Boolean(env.DB),
        queueBound: Boolean(env.BROADCAST_QUEUE),
        mainWebhookSecretRequired: Boolean(env.WEBHOOK_SECRET),
        adminWebhookSecretRequired: Boolean(env.ADMIN_WEBHOOK_SECRET),
      });
    }

    if (request.method === 'GET' && url.pathname === '/diagnose') {
      if (!env.DIAG_KEY || request.headers.get('X-Diag-Key') !== env.DIAG_KEY) {
        return text('forbidden', 403);
      }
      return json(await runDiagnostics(env));
    }

    if (url.pathname === '/webhook') {
      if (request.method === 'GET') return text('OK');
      if (request.method !== 'POST') return text('Method Not Allowed', 405);
      if (!getMainToken(env)) return text('MAIN_BOT_TOKEN is not configured', 500);
      if (!checkSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.WEBHOOK_SECRET)) {
        console.warn(`MAIN webhook rejected: bad secret from ${request.headers.get('cf-connecting-ip') ?? '?'}`);
        return text('forbidden', 403);
      }

      const update = await readUpdate(request);
      if (!update) return text('bad request', 400);
      if (!update.update_id) return json({ ok: true });

      try {
        await handleMainUpdate(update, env, ctx);
      } catch (err) {
        console.error(`MAIN HANDLER FAIL update_id=${update.update_id}`, err);
      }
      return json({ ok: true });
    }

    if (url.pathname === '/admin/webhook') {
      if (request.method === 'GET') return text('OK');
      if (request.method !== 'POST') return text('Method Not Allowed', 405);
      if (!getAdminToken(env)) return text('ADMIN_BOT_TOKEN is not configured', 500);
      if (!checkSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.ADMIN_WEBHOOK_SECRET)) {
        console.warn(`ADMIN webhook rejected: bad secret from ${request.headers.get('cf-connecting-ip') ?? '?'}`);
        return text('forbidden', 403);
      }

      const update = await readUpdate(request);
      if (!update) return text('bad request', 400);
      if (!update.update_id) return json({ ok: true });

      try {
        await handleAdminUpdate(update, env, ctx);
      } catch (err) {
        console.error(`ADMIN HANDLER FAIL update_id=${update.update_id}`, err);
      }
      return json({ ok: true });
    }

    return text('Not Found', 404);
  },

  async queue(batch: MessageBatch<QueueJob>, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleQueue(batch, env, ctx);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env, event, ctx));
  },
};
