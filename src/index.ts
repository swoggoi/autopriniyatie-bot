interface TelegramResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

async function tgRequest(token: string, path: string, body?: unknown): Promise<TelegramResponse> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<TelegramResponse>;
}

export default {
  async fetch(request: Request, env: { BOT_TOKEN: string; ADMIN_ID: string; CHANNEL_ID: string; BOT_KV: KVNamespace }, ctx: ExecutionContext): Promise<Response> {
    const { BOT_TOKEN, ADMIN_ID, CHANNEL_ID, BOT_KV } = env;

    if (!BOT_TOKEN) {
      return new Response('BOT_TOKEN not configured', { status: 500 });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/webhook') {
      return new Response('OK');
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      try {
        const update = await request.json() as Record<string, unknown>;

        if (!update?.update_id) {
          return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
        }

        const chatJoinRequest = update.chat_join_request as Record<string, unknown> | undefined;

        if (chatJoinRequest) {
          const fromUser = chatJoinRequest.from as Record<string, unknown>;
          const chat = chatJoinRequest.chat as Record<string, unknown>;
          const userId = fromUser.id as number;
          const username = (fromUser.username || 'bez_nika') as string;
          const fullName = (fromUser.full_name || 'Bez imeni') as string;
          const chatId = String(chat.id);

          if (chatId !== CHANNEL_ID) {
            return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
          }

          const processedKey = `processed:${userId}`;
          const exists = await BOT_KV.get(processedKey);
          if (exists) {
            return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
          }

          const approveRes = await tgRequest(BOT_TOKEN, 'approveChatJoinRequest', {
            chat_id: chatId,
            user_id: userId,
          });

          if (approveRes.ok) {
            await BOT_KV.put(processedKey, '1', { expirationTtl: 31536000 });
          }
        }

        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        console.error('Webhook error:', err);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};