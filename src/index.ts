import { Hono } from 'hono';

interface TelegramResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

interface BotEnv {
  BOT_TOKEN: string;
  ADMIN_ID: string;
  CHANNEL_ID: string;
}

function tgRequest(token: string, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<TelegramResponse> {
  const url = `https://api.telegram.org/bot${token}/${path}`;
  const options: RequestInit = { method };
  if (body) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  return fetch(url, options).then(r => r.json()) as Promise<TelegramResponse>;
}

async function handleJoinRequest(env: BotEnv, chatId: string, userId: number, username: string, fullName: string, kv: KVNamespace) {
  if (String(chatId) !== env.CHANNEL_ID) {
    console.log(`Заявка в другой канал (chat_id=${chatId}), ожидался ${env.CHANNEL_ID}. Пропуск.`);
    return;
  }

  const processedKey = `processed:${userId}`;
  const exists = await kv.get(processedKey);
  if (exists) {
    console.log(`Заявка ID:${userId} уже обработана. Пропуск.`);
    return;
  }

  console.log(`Новая заявка: ${fullName} (ID: ${userId}, @${username || 'bez_nika'})`);

  const approveRes = await tgRequest(env.BOT_TOKEN, 'approveChatJoinRequest', 'POST', {
    chat_id: chatId,
    user_id: userId,
  });
  if (!approveRes.ok) {
    console.error(`Ошибка одобрения ${fullName} (ID: ${userId}): ${approveRes.description}`);
    return;
  }

  await kv.put(processedKey, '1', { expirationTtl: 31536000 });
  console.log(`Заявка ${fullName} (ID: ${userId}) ОДОБРЕНА.`);

  try {
    await tgRequest(env.BOT_TOKEN, 'sendMessage', 'POST', {
      chat_id: userId,
      text: 'Привет! Рад видеть тебя в канале. Твоя заявка одобрена!',
    });
    console.log(`Уведомление отправлено ${fullName} (ID: ${userId}).`);
  } catch (e) {
    console.log(`Не удалось отправить ЛС ID:${userId}: ${e}`);
  }
}

async function handleCommand(env: BotEnv, userId: number, chatId: number, text: string, kv: KVNamespace) {
  const adminId = parseInt(env.ADMIN_ID, 10);
  if (!env.ADMIN_ID || userId !== adminId) return;

  if (text === '/status') {
    let count = 0;
    const keys = await kv.list({ prefix: 'processed:' });
    count = keys.keys.length;
    await tgRequest(env.BOT_TOKEN, 'sendMessage', 'POST', {
      chat_id: chatId,
      text: `Бот запущен и работает\n\nID канала: ${env.CHANNEL_ID}\nРежим: автоматическое одобрение заявок\nОбработано за сессию: ${count}`,
    });
    console.log(`Команда /status от администратора ${userId}`);
  }

  if (text === '/chat_id') {
    await tgRequest(env.BOT_TOKEN, 'sendMessage', 'POST', {
      chat_id: chatId,
      text: `Информация о чате:\nID чата: ${chatId}\nТип: private`,
    });
    console.log(`Команда /chat_id — chat_id=${chatId}`);
  }

  if (text.startsWith('/approve_pending')) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      await tgRequest(env.BOT_TOKEN, 'sendMessage', 'POST', {
        chat_id: chatId,
        text: 'Использование: /approve_pending user_id1 [user_id2 ...]\nПример: /approve_pending 123456789',
      });
      return;
    }

    let approved = 0;
    let failed = 0;

    for (let i = 1; i < parts.length; i++) {
      const uid = parseInt(parts[i], 10);
      if (isNaN(uid)) {
        await tgRequest(env.BOT_TOKEN, 'sendMessage', 'POST', {
          chat_id: chatId,
          text: `'${parts[i]}' не является валидным ID.`,
        });
        continue;
      }

      try {
        const res = await tgRequest(env.BOT_TOKEN, 'approveChatJoinRequest', 'POST', {
          chat_id: env.CHANNEL_ID,
          user_id: uid,
        });
        if (res.ok) {
          approved++;
          await kv.put(`processed:${uid}`, '1', { expirationTtl: 31536000 });
          console.log(`Заявка ID:${uid} одобрена командой /approve_pending`);
          await tgRequest(env.BOT_TOKEN, 'sendMessage', 'POST', {
            chat_id: uid,
            text: 'Привет! Рад видеть тебя в канале. Твоя заявка одобрена!',
          });
        } else {
          failed++;
          console.error(`Ошибка одобрения ID:${uid}: ${res.description}`);
        }
      } catch (e) {
        failed++;
        console.error(`Ошибка при одобрении ID:${uid}: ${e}`);
      }
    }

    await tgRequest(env.BOT_TOKEN, 'sendMessage', 'POST', {
      chat_id: chatId,
      text: `Результат:\n  Одобрено: ${approved}\n  Ошибок: ${failed}`,
    });
  }
}

function handleMyChatMember(data: Record<string, unknown>) {
  const chat = data.chat as Record<string, unknown>;
  const newStatus = (data.new_chat_member as Record<string, unknown>)?.status;
  const oldStatus = (data.old_chat_member as Record<string, unknown>)?.status;
  console.log(`Статус бота в '${chat.title}' (ID: ${chat.id}): ${oldStatus} -> ${newStatus}`);
}

const app = new Hono<{ Bindings: { BOT_KV: KVNamespace; BOT_TOKEN: string; ADMIN_ID: string; CHANNEL_ID: string } }>();

app.post('/webhook', async (c) => {
  const env = {
    BOT_TOKEN: c.env.BOT_TOKEN,
    ADMIN_ID: c.env.ADMIN_ID,
    CHANNEL_ID: c.env.CHANNEL_ID,
  };
  const kv = c.env.BOT_KV;
  const update = await c.req.json();

  if (!update?.update_id) {
    return c.json({ ok: true });
  }

  const chatJoinRequest = update.chat_join_request as Record<string, unknown> | undefined;
  const message = update.message as Record<string, unknown> | undefined;
  const myChatMember = update.my_chat_member as Record<string, unknown> | undefined;

  if (chatJoinRequest) {
    const fromUser = chatJoinRequest.from as Record<string, unknown>;
    const chat = chatJoinRequest.chat as Record<string, unknown>;
    const userId = fromUser.id as number;
    const username = (fromUser.username || 'bez_nika') as string;
    const fullName = (fromUser.full_name || 'Bez imeni') as string;
    await handleJoinRequest(env, String(chat.id), userId, username, fullName, kv);
  }

  if (message) {
    const fromUser = message.from as Record<string, unknown>;
    const text = message.text as string | undefined;
    const chatId = (message.chat as Record<string, unknown>).id as number;
    const userId = fromUser.id as number;

    if (text && text.startsWith('/')) {
      await handleCommand(env, userId, chatId, text, kv);
    }
  }

  if (myChatMember) {
    handleMyChatMember(myChatMember);
  }

  return c.json({ ok: true });
});

app.get('/webhook', async (c) => {
  return c.text('OK');
});

export default {
  async fetch(request: Request, env: { BOT_TOKEN: string; ADMIN_ID: string; CHANNEL_ID: string; BOT_KV: KVNamespace }, ctx: ExecutionContext) {
    if (!env.BOT_TOKEN) {
      return new Response('BOT_TOKEN not configured', { status: 500 });
    }

    if (request.url.includes('/webhook')) {
      return app.fetch(request, env, ctx);
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && (url.pathname === '/set-webhook' || url.searchParams.has('webhook'))) {
      const webhookUrl = url.searchParams.get('webhook') || `${request.url.replace(/\/set-webhook$/, '')}/webhook`;
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, allowed_updates: ['chat_join_request', 'message', 'my_chat_member'] }),
      });
      const data = await res.json();
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'GET' && url.pathname === '/get-webhook') {
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`);
      const data = await res.json();
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    }

    return app.fetch(request, env, ctx);
  },
};