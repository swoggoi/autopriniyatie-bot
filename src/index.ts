interface Env {
  BOT_TOKEN: string;
  ADMIN_ID: string;
  CHANNEL_ID: string;
  BOT_KV: KVNamespace;
  WEBHOOK_SECRET?: string;
  DIAG_KEY?: string;
}

interface TelegramResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  result?: unknown;
}

interface CallResult {
  status: number;
  data: TelegramResponse;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function tgCall(token: string, method: string, body?: unknown): Promise<CallResult> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

  let data: TelegramResponse;
  try {
    data = (await res.json()) as TelegramResponse;
  } catch {
    data = { ok: false, description: `non-JSON reply to ${method} (HTTP ${res.status})` };
  }

  if (!data.ok) {
    console.error(
      `TG_FAIL method=${method} http=${res.status} error_code=${data.error_code ?? '?'} description=${data.description ?? '?'}`,
    );
  }

  return { status: res.status, data };
}

async function kvGet(kv: KVNamespace | undefined, key: string): Promise<string | null> {
  if (!kv) return null;
  try {
    return await kv.get(key);
  } catch (err) {
    console.error(`KV_GET_FAIL key=${key}`, err);
    return null;
  }
}

async function handleJoinRequest(update: Record<string, unknown>, env: Env): Promise<void> {
  const req = update.chat_join_request as Record<string, unknown>;
  const from = (req.from ?? {}) as Record<string, unknown>;
  const chat = (req.chat ?? {}) as Record<string, unknown>;

  const userId = from.id as number;
  const username = (from.username as string) ?? 'no_nick';
  const fullName = (from.full_name as string) ?? 'No name';
  const chatId = String(chat.id);

  if (!userId || !Number.isFinite(userId)) {
    console.error('JOIN malformed: no user id', JSON.stringify(req));
    return;
  }

  if (chatId !== env.CHANNEL_ID) {
    console.warn(`JOIN skipped: chat ${chatId} != configured CHANNEL_ID ${env.CHANNEL_ID}`);
    return;
  }

  const { status, data } = await tgCall(env.BOT_TOKEN, 'approveChatJoinRequest', {
    chat_id: chatId,
    user_id: userId,
  });

  if (data.ok) {
    console.log(`JOIN approved: user=${userId} @${username} (${fullName})`);
    try {
      await env.BOT_KV?.put(`processed:${chatId}:${userId}`, String(Date.now()), {
        expirationTtl: 31536000,
      });
    } catch (err) {
      console.error(`KV_PUT_FAIL (approval still went through)`, err);
    }
  } else {
  const benign = /ALREADY_PARTICIPANT|USER_ALREADY_PARTICIPANT|CHAT_ADMIN_REQUIRED|TOPIC_CLOSED/i;
  if (!benign.test(data.description ?? '')) {
    console.error(
      `JOIN NOT approved: user=${userId} @${username} http=${status} description=${data.description ?? '?'}`,
    );
  } else {
    console.log(`JOIN already settled: user=${userId} @${username} (${data.description})`);
  }
}
}

function handleMyChatMember(update: Record<string, unknown>): void {
  const update_ = update.my_chat_member as Record<string, unknown>;
  const chat = (update_.chat ?? {}) as Record<string, unknown>;
  const from = (update_.from ?? {}) as Record<string, unknown>;
  const newState = (update_.new_chat_member ?? {}) as Record<string, unknown>;

  console.log(
    `ADMIN_CHANGE chat=${chat.id} title=${chat.title ?? '?'} by=${from.username ?? from.id} ` +
      `status=${newState.status} can_invite=${newState.can_invite_users} can_manage=${newState.can_manage_chat}`,
  );

  if (newState.status !== 'administrator' || !newState.can_invite_users) {
    console.error('ADMIN_CHANGE WARNING: bot can no longer approve join requests in this chat');
  }
}

async function runDiagnostics(env: Env): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { configured: true, checks: {} };
  const checks = out.checks as Record<string, unknown>;

  const me = await tgCall(env.BOT_TOKEN, 'getMe');
  checks.getMe = me.data.ok
    ? { ok: true, username: (me.data.result as { username?: string })?.username }
    : { ok: false, http: me.status, description: me.data.description };

  const wh = await tgCall(env.BOT_TOKEN, 'getWebhookInfo');
  if (wh.data.ok) {
    const info = wh.data.result as Record<string, unknown>;
    checks.webhook = {
      ok: true,
      url: info.url,
      pending_update_count: info.pending_update_count,
      last_error_message: info.last_error_message ?? null,
      last_error_date: info.last_error_date ?? null,
    };
  } else {
    checks.webhook = { ok: false, http: wh.status, description: wh.data.description };
  }

  const chat = await tgCall(env.BOT_TOKEN, 'getChat', { chat_id: env.CHANNEL_ID });
  checks.chat = chat.data.ok
    ? {
        ok: true,
      title: (chat.data.result as { title?: string })?.title,
      id: (chat.data.result as { id?: number })?.id,
    }
    : { ok: false, http: chat.status, description: chat.data.description };

  if (me.data.ok) {
    const botId = (me.data.result as { id?: number })?.id;
    const member = await tgCall(env.BOT_TOKEN, 'getChatMember', {
      chat_id: env.CHANNEL_ID,
      user_id: botId,
    });
    checks.botMembership = member.data.ok
      ? { ok: true, status: (member.data.result as { status?: string })?.status }
      : { ok: false, http: member.status, description: member.data.description };
  }

  try {
    await env.BOT_KV?.put('diag:probe', String(Date.now()), { expirationTtl: 60 });
    checks.kv = { ok: true };
  } catch (err) {
    checks.kv = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (!env.BOT_TOKEN) {
      return new Response('BOT_TOKEN is not configured', { status: 500 });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: true,
        hasToken: true,
        channelId: env.CHANNEL_ID,
        kvBound: Boolean(env.BOT_KV),
        webhookSecretRequired: Boolean(env.WEBHOOK_SECRET),
      });
    }

    if (request.method === 'GET' && url.pathname === '/diagnose') {
      if (!env.DIAG_KEY || request.headers.get('X-Diag-Key') !== env.DIAG_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      return json(await runDiagnostics(env));
    }

    if (url.pathname !== '/webhook') {
      return new Response('Not Found', { status: 404 });
    }

    if (request.method === 'GET') {
      return new Response('OK', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (env.WEBHOOK_SECRET) {
      const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (provided !== env.WEBHOOK_SECRET) {
        console.warn(`WEBHOOK rejected: bad secret token from ${request.headers.get('cf-connecting-ip') ?? '?'}`);
        return new Response('forbidden', { status: 403 });
      }
    }

    let update: Record<string, unknown>;
    try {
      update = (await request.json()) as Record<string, unknown>;
    } catch {
      console.error('WEBHOOK invalid JSON body');
      return new Response('bad request', { status: 400 });
    }

    if (!update?.update_id) {
      console.warn('WEBHOOK update without update_id', JSON.stringify(update));
      return json({ ok: true });
    }

    try {
      if (update.chat_join_request) {
        await handleJoinRequest(update, env);
      } else if (update.my_chat_member) {
        handleMyChatMember(update);
      } else {
        const type = Object.keys(update).find((k) => k !== 'update_id') ?? 'unknown';
        console.log(`UPDATE ignored type=${type}`);
      }
    } catch (err) {
      console.error(`HANDLER FAIL update_id=${update.update_id}`, err);
    }

    return json({ ok: true });
  },
};
