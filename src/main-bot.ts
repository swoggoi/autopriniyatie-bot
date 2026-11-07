import type { Env, TelegramCallbackQuery, TelegramMessage, TelegramUpdate, TelegramUser } from './types';
import {
  getLinkMap,
  listLinks,
  markApproved,
  markStarted,
  recordJoinRequest,
  recordChannelMember,
  ensureUser,
  setConsent,
  setDmStatus,
  getUser,
} from './db';
import { getChannelIds, getMainToken } from './env';
import { answerCallback, editText, escapeHtml, isBenignApprovalError, sendText, tgCall } from './telegram';
import { processWelcomeJob } from './welcome';
import { CONSENT_TEXT } from './defaults';

function consentKeyboard(consented: boolean, channelUrl?: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
} {
  const rows: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];
  if (consented) {
    rows.push([{ text: '❌ Отозвать согласие', callback_data: 'consent:no' }]);
  } else {
    rows.push([{ text: '✅ Согласен на рассылку', callback_data: 'consent:yes' }]);
    rows.push([{ text: '❌ Не хочу рассылку', callback_data: 'consent:no' }]);
  }
  if (channelUrl) rows.push([{ text: '🔗 Перейти в канал', url: channelUrl }]);
  return { inline_keyboard: rows };
}

async function handleStart(env: Env, message: TelegramMessage): Promise<void> {
  const token = getMainToken(env);
  const from = message.from;
  if (!from) return;

  await markStarted(env.DB, from, message.chat.id);
  const user = await getUser(env.DB, from.id);
  const linkMap = await getLinkMap(env.DB);
  const channelUrl = linkMap.main?.url;

  const name = escapeHtml(from.first_name || from.username || 'друг');
  const consentLine = user?.consent_broadcasts
    ? '\n\n✅ Вы уже дали согласие на получение рассылок.'
    : '';

  const text =
    `<b>Здравствуйте, ${name}!</b>\n\n` +
    'Вы подключились к боту закрытого канала. Здесь будут появляться важные объявления и обновления.' +
    consentLine +
    '\n\n' +
    CONSENT_TEXT.replace('<b>Вы подписались на бота.</b>\n\n', '');

  const result = await sendText(token, message.chat.id, text, consentKeyboard(Boolean(user?.consent_broadcasts), channelUrl));
  if (!result.ok) console.warn(`START reply failed user=${from.id} description=${result.description ?? '?'}`);
}

async function handleStop(env: Env, message: TelegramMessage): Promise<void> {
  const token = getMainToken(env);
  const from = message.from;
  if (!from) return;
  await setConsent(env.DB, from.id, false, 'command:/stop');
  await sendText(
    token,
    message.chat.id,
    '<b>Вы отписались от рассылок.</b>\n\nСлужебные сообщения, связанные с заявкой на вступление, могут приходить и дальше.\n\nВозобновить рассылку: /start',
    {
      inline_keyboard: [[{ text: '✅ Возобновить рассылку', callback_data: 'consent:yes' }]],
    },
  );
}

async function handleLinks(env: Env, message: TelegramMessage): Promise<void> {
  const token = getMainToken(env);
  const links = await listLinks(env.DB, true);
  if (!links.length) {
    await sendText(token, message.chat.id, 'Ссылки пока не настроены администратором.');
    return;
  }
  const text = ['<b>Наши каналы</b>', ...links.map((l) => `• ${escapeHtml(l.title)}: ${escapeHtml(l.url)}`)].join('\n');
  await sendText(token, message.chat.id, text);
}

async function handleHelp(env: Env, message: TelegramMessage): Promise<void> {
  const token = getMainToken(env);
  await sendText(
    token,
    message.chat.id,
    '<b>Доступные команды</b>\n\n' +
      '/start — регистрация и настройка рассылки\n' +
      '/stop — отозвать согласие на рассылку\n' +
      '/links — ссылки на каналы\n' +
      '/id — ваш Telegram ID\n' +
      '/help — эта справка',
  );
}

async function handleMainMessage(env: Env, message: TelegramMessage): Promise<void> {
  const from = message.from;
  if (!from || from.is_bot) return;
  const token = getMainToken(env);
  const text = (message.text ?? '').trim();

  if (text.startsWith('/start')) return handleStart(env, message);
  if (text.startsWith('/stop')) return handleStop(env, message);
  if (text.startsWith('/links')) return handleLinks(env, message);
  if (text.startsWith('/help')) return handleHelp(env, message);
  if (text.startsWith('/id')) {
    await sendText(token, message.chat.id, `Ваш Telegram ID: <code>${from.id}</code>`);
    return;
  }

  // Any private message proves that the bot can reach this chat.
  await markStarted(env.DB, from, message.chat.id);
  await sendText(
    token,
    message.chat.id,
    'Сообщение получено. Управление подпиской доступно через /start, справка — /help.',
  );
}

async function handleMainCallback(env: Env, query: TelegramCallbackQuery): Promise<void> {
  const token = getMainToken(env);
  const from = query.from;
  const data = query.data ?? '';
  const message = query.message;

  if (data === 'consent:yes') {
    await setConsent(env.DB, from.id, true, 'inline:consent');
    await answerCallback(token, query.id, 'Согласие сохранено');
    if (message) {
      await editText(
        token,
        message.chat.id,
        message.message_id,
        '<b>Спасибо!</b>\n\nВы согласились получать важные обновления и рассылки. Отозвать согласие можно командой /stop.',
        { inline_keyboard: [[{ text: '❌ Отозвать согласие', callback_data: 'consent:no' }]] },
      );
    }
    return;
  }

  if (data === 'consent:no') {
    await setConsent(env.DB, from.id, false, 'inline:consent');
    await answerCallback(token, query.id, 'Согласие отозвано');
    if (message) {
      await editText(
        token,
        message.chat.id,
        message.message_id,
        '<b>Вы отписались от рассылок.</b>\n\nСлужебные сообщения по заявке могут приходить и дальше. Возобновить: /start',
        { inline_keyboard: [[{ text: '✅ Возобновить рассылку', callback_data: 'consent:yes' }]] },
      );
    }
    return;
  }

  await answerCallback(token, query.id);
}

async function handleJoinRequest(
  env: Env,
  update: NonNullable<TelegramUpdate['chat_join_request']>,
  ctx: ExecutionContext,
): Promise<void> {
  const token = getMainToken(env);
  const from = update.from;
  const chatId = String(update.chat.id);

  if (!from?.id || !Number.isFinite(from.id)) {
    console.error('JOIN malformed: no user id');
    return;
  }

  const channelIds = getChannelIds(env);
  if (!channelIds.includes(chatId)) {
    console.warn(`JOIN skipped: chat ${chatId} not in configured channels [${channelIds.join(', ')}]`);
    return;
  }

  await recordJoinRequest(env.DB, from, update.user_chat_id, update.date, Number(chatId));

  const approval = await tgCall(token, 'approveChatJoinRequest', {
    chat_id: chatId,
    user_id: from.id,
  });

  const settled = approval.ok || isBenignApprovalError(approval.description);
  if (!settled) {
    console.error(
      `JOIN NOT approved user=${from.id} http=${approval.status} description=${approval.description ?? '?'}`,
    );
    return;
  }

  await markApproved(env.DB, from.id);
  await recordChannelMember(env.DB, from, Number(chatId), 'member');

  const job = {
    type: 'welcome' as const,
    chatId,
    userId: from.id,
    userChatId: update.user_chat_id,
    requestDate: update.date,
    dedupeKey: `welcome:${chatId}:${from.id}:${update.date}`,
  };

  try {
    await env.BROADCAST_QUEUE.send(job, { delaySeconds: 0 });
  } catch (err) {
    // Queue failure must not lose the welcome message; send it in the background.
    console.error('WELCOME enqueue failed, using waitUntil fallback', err);
    ctx.waitUntil(
      processWelcomeJob(env, job).catch((fallbackErr) => {
        console.error('WELCOME fallback failed', fallbackErr);
      }),
    );
  }

  console.log(
    `JOIN ${approval.ok ? 'approved' : 'already settled'}: user=${from.id} @${from.username ?? 'no_nick'} chat=${chatId}`,
  );
}

/**
 * Best-effort channel subscription tracking. Telegram does not guarantee
 * `chat_member` updates for channels; join requests remain the primary source.
 * This handler only records membership and never marks a user as DM-reachable.
 */
async function handleChatMember(
  env: Env,
  update: NonNullable<TelegramUpdate['chat_member']>,
): Promise<void> {
  const chatId = String(update.chat.id);
  const channelIds = getChannelIds(env);
  if (!channelIds.includes(chatId)) return;

  const user = update.new_chat_member?.user ?? update.from;
  if (!user?.id || user.is_bot) return;

  const status = update.new_chat_member?.status ?? 'unknown';
  await recordChannelMember(
    env.DB,
    user,
    Number(chatId),
    status,
    new Date(update.date * 1000).toISOString(),
  );
  console.log(`CHANNEL_MEMBER ${status}: user=${user.id} @${user.username ?? 'no_nick'} chat=${chatId}`);
}

async function handleMyChatMember(
  env: Env,
  update: NonNullable<TelegramUpdate['my_chat_member']>,
): Promise<void> {
  if (update.chat.type !== 'private') return;
  const newStatus = update.new_chat_member?.status ?? 'unknown';
  if (newStatus === 'kicked') {
    await ensureUser(env.DB, update.from.id);
    await setDmStatus(env.DB, update.from.id, 'blocked', 'bot blocked by user');
    console.log(`DM blocked user=${update.from.id}`);
  } else if (newStatus === 'member') {
    await markStarted(env.DB, update.from as TelegramUser, update.chat.id);
    console.log(`DM allowed user=${update.from.id}`);
  }
}

export async function handleMainUpdate(
  update: TelegramUpdate,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  if (update.chat_join_request) {
    await handleJoinRequest(env, update.chat_join_request, ctx);
    return;
  }
  if (update.chat_member) {
    await handleChatMember(env, update.chat_member);
    return;
  }
  if (update.my_chat_member) {
    await handleMyChatMember(env, update.my_chat_member);
    return;
  }
  if (update.message) {
    await handleMainMessage(env, update.message);
    return;
  }
  if (update.callback_query) {
    await handleMainCallback(env, update.callback_query);
    return;
  }
  const type = Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';
  console.log(`MAIN update ignored type=${type}`);
}
