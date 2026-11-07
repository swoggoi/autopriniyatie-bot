import type {
  AdminSession,
  AudienceSegment,
  BroadcastRow,
  Content,
  Env,
  StoredButton,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
  WelcomeConfig,
} from './types';
import { SEGMENT_LABELS } from './types';
import {
  audienceWhere,
  broadcastRecipientBreakdown,
  clearSession,
  countAudience,
  countAudienceWithoutConsent,
  createBroadcast,
  createLink,
  deleteLink,
  findUser,
  getBroadcast,
  getBroadcastRate,
  getLink,
  getLinkMap,
  getSession,
  getStats,
  getUser,
  getWelcomeConfig,
  listBroadcasts,
  listLinks,
  listRecentUsers,
  nowIso,
  pauseBroadcast,
  resumeBroadcast,
  setBroadcastRate,
  setSession,
  setWelcomeConfig,
  stopBroadcast,
  updateLink,
} from './db';
import { getAdminIds, getAdminToken, getMainToken, isAdmin } from './env';
import {
  answerCallback,
  classifyTelegramError,
  editText,
  escapeHtml,
  sendContent,
  sendText,
  tgCall,
  truncate,
} from './telegram';
import { DEFAULT_WELCOME, MAIN_MENU_TITLE } from './defaults';
import { buildWelcomeContent } from './welcome';

type AdminButton = { text: string; callback_data?: string; url?: string };
type AdminKeyboard = { inline_keyboard: AdminButton[][] };

type ContentType = 'text' | 'photo' | 'video';

interface ComposerData {
  contentType?: ContentType;
  content?: Content;
  buttons?: StoredButton[];
  audience?: AudienceSegment;
  confirmed?: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'черновик',
  running: 'идёт',
  paused: 'пауза',
  stopped: 'остановлена',
  completed: 'завершена',
  failed: 'ошибка',
};

const SEGMENT_ORDER: AudienceSegment[] = ['all_allowed', 'started', 'approved', 'consented', 'test'];

const adminToken = (env: Env): string => getAdminToken(env);

function menuKeyboard(): AdminKeyboard {
  return {
    inline_keyboard: [
      [{ text: '📊 Статистика', callback_data: 'menu:stats' }],
      [{ text: '📢 Создать рассылку', callback_data: 'menu:bc_new' }],
      [{ text: '📋 Управление рассылками', callback_data: 'menu:bc_list' }],
      [{ text: '🔗 Ссылки на каналы', callback_data: 'menu:links' }],
      [{ text: '💬 Приветственное сообщение', callback_data: 'menu:welcome' }],
      [{ text: '👥 Пользователи', callback_data: 'menu:users' }],
      [{ text: '⚙️ Настройки', callback_data: 'menu:settings' }],
    ],
  };
}

function backRow(callback = 'menu:main', label = '⬅️ В главное меню'): AdminButton[] {
  return [{ text: label, callback_data: callback }];
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  } catch {
    return value;
  }
}

function percent(part: number, total: number): string {
  if (!total) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function dmLabel(user: { dm_status: string; can_receive_messages: number }): string {
  if (user.can_receive_messages) return '✅ можно писать';
  if (user.dm_status === 'blocked') return '🚫 заблокировал бота';
  if (user.dm_status === 'unreachable') return '⚠️ недоступен';
  return '❔ неизвестно';
}

async function render(
  env: Env,
  chatId: number,
  messageId: number | undefined,
  text: string,
  keyboard?: AdminKeyboard,
): Promise<void> {
  const token = adminToken(env);
  if (messageId) {
    const edited = await editText(token, chatId, messageId, text, keyboard);
    if (edited.ok) return;
  }
  await sendText(token, chatId, text, keyboard);
}

async function notify(env: Env, chatId: number, text: string, keyboard?: AdminKeyboard): Promise<void> {
  await sendText(adminToken(env), chatId, text, keyboard);
}

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

function composerFromSession(session: AdminSession): ComposerData {
  return session.data as unknown as ComposerData;
}

function contentSummary(content: Content | undefined): string {
  if (!content) return 'не задан';
  if (content.contentType === 'text') {
    return `текст (${(content.text ?? '').length} символов)`;
  }
  return `${content.contentType === 'photo' ? 'фото' : 'видео'} + подпись (${(content.caption ?? '').length} символов)`;
}

function contentFromMessage(message: TelegramMessage, contentType: ContentType): { content?: Content; error?: string } {
  if (contentType === 'text') {
    if (!message.text?.trim()) return { error: 'Отправьте обычный текст сообщения.' };
    return {
      content: {
        contentType: 'text',
        text: message.text,
        caption: '',
        parseMode: 'HTML',
        buttons: [],
      },
    };
  }

  if (contentType === 'photo') {
    const photo = message.photo?.[message.photo.length - 1];
    if (!photo) return { error: 'Отправьте фотографию (не файл и не текст).' };
    return {
      content: {
        contentType: 'photo',
        text: '',
        caption: message.caption ?? '',
        fileId: photo.file_id,
        parseMode: message.caption ? 'HTML' : null,
        buttons: [],
      },
    };
  }

  if (!message.video) return { error: 'Отправьте видео (не файл и не текст).' };
  return {
    content: {
      contentType: 'video',
      text: '',
      caption: message.caption ?? '',
      fileId: message.video.file_id,
      parseMode: message.caption ? 'HTML' : null,
      buttons: [],
    },
  };
}

function contentForSend(content: Content, buttons: StoredButton[]): { content: Content; buttons: StoredButton[] } {
  return { content: { ...content, buttons }, buttons };
}

async function showMainMenu(env: Env, chatId: number, messageId?: number): Promise<void> {
  await render(env, chatId, messageId, MAIN_MENU_TITLE, menuKeyboard());
}

async function showStats(env: Env, chatId: number, messageId?: number): Promise<void> {
  const stats = await getStats(env.DB);
  const broadcasts = await listBroadcasts(env.DB, 5);

  const lines = [
    '<b>📊 Статистика</b>',
    '',
    `Всего пользователей: <b>${stats.total}</b>`,
    `Можно писать в личку: <b>${stats.allowed}</b>`,
    `Запускали основного бота: <b>${stats.started}</b>`,
    `Заявки одобрены: <b>${stats.approved}</b>`,
    `Согласие на рассылки: <b>${stats.consented}</b>`,
    '',
    '<b>Последние рассылки</b>',
  ];

  if (!broadcasts.length) {
    lines.push('Пока нет рассылок.');
  } else {
    for (const b of broadcasts) {
      lines.push(
        `#${b.id} ${statusLabel(b.status)} — ${b.sent}/${b.total} (${percent(b.sent, b.total)}), ошибок: ${b.failed + b.blocked + b.unreachable}`,
      );
    }
  }

  lines.push('', '<i>Успешная отправка подтверждает приём API Telegram, а не прочтение сообщения.</i>');

  await render(env, chatId, messageId, lines.join('\n'), {
    inline_keyboard: [
      [{ text: '📋 Управление рассылками', callback_data: 'menu:bc_list' }],
      [{ text: '🔄 Обновить', callback_data: 'menu:stats' }],
      backRow(),
    ],
  });
}

async function showBroadcastList(env: Env, chatId: number, messageId?: number): Promise<void> {
  const broadcasts = await listBroadcasts(env.DB, 10);
  if (!broadcasts.length) {
    await render(
      env,
      chatId,
      messageId,
      '<b>📋 Рассылки</b>\n\nПока нет ни одной рассылки.',
      { inline_keyboard: [[{ text: '📢 Создать рассылку', callback_data: 'menu:bc_new' }], backRow()] },
    );
    return;
  }

  const rows: AdminButton[][] = broadcasts.map((b) => [
    {
      text: `#${b.id} ${statusLabel(b.status)} · ${b.sent}/${b.total}`,
      callback_data: `bc:detail:${b.id}`,
    },
  ]);
  rows.push([{ text: '📢 Создать рассылку', callback_data: 'menu:bc_new' }]);
  rows.push(backRow());

  await render(
    env,
    chatId,
    messageId,
    '<b>📋 Рассылки</b>\n\nВыберите рассылку для управления.',
    { inline_keyboard: rows },
  );
}

async function showBroadcastDetail(env: Env, chatId: number, id: number, messageId?: number): Promise<void> {
  const b = await getBroadcast(env.DB, id);
  if (!b) {
    await render(env, chatId, messageId, 'Рассылка не найдена.', { inline_keyboard: [backRow('menu:bc_list')] });
    return;
  }
  const pending = Math.max(0, b.total - b.sent - b.failed - b.blocked - b.unreachable - b.skipped);
  const processed = b.total - pending;

  const text =
    `<b>Рассылка #${b.id}</b>\n` +
    `Название: ${escapeHtml(b.name)}\n` +
    `Статус: <b>${statusLabel(b.status)}</b>\n` +
    `Аудитория: ${escapeHtml(SEGMENT_LABELS[b.audience] ?? b.audience)}\n` +
    `Контент: ${b.content_type}\n` +
    `Создана: ${formatDate(b.created_at)}\n` +
    `Запущена: ${formatDate(b.started_at)}\n` +
    `Завершена: ${formatDate(b.completed_at)}\n\n` +
    `<b>Прогресс</b>\n` +
    `Всего получателей: ${b.total}\n` +
    `Обработано: ${processed} (${percent(processed, b.total)})\n` +
    `✅ Успешно отправлено: ${b.sent} (${percent(b.sent, b.total)})\n` +
    `⚠️ Неудачно: ${b.failed}\n` +
    `🚫 Заблокировали бота: ${b.blocked}\n` +
    `👻 Недоступны: ${b.unreachable}\n` +
    `⏭ Пропущено: ${b.skipped}\n` +
    (b.last_error ? `\nПоследняя ошибка: <code>${escapeHtml(truncate(b.last_error, 300))}</code>` : '');

  const rows: AdminButton[][] = [];
  if (b.status === 'running') {
    rows.push([{ text: '⏸ Приостановить', callback_data: `bc:pause:${b.id}` }]);
    rows.push([{ text: '⏹ Остановить', callback_data: `bc:stopc:${b.id}` }]);
  } else if (b.status === 'paused') {
    rows.push([{ text: '▶️ Возобновить', callback_data: `bc:resume:${b.id}` }]);
    rows.push([{ text: '⏹ Остановить', callback_data: `bc:stopc:${b.id}` }]);
  }
  rows.push([{ text: '🔄 Обновить', callback_data: `bc:detail:${b.id}` }]);
  rows.push(backRow('menu:bc_list'));

  await render(env, chatId, messageId, text, { inline_keyboard: rows });
}

async function showUsers(env: Env, chatId: number, messageId?: number): Promise<void> {
  const stats = await getStats(env.DB);
  const recent = await listRecentUsers(env.DB, 10);
  const lines = [
    '<b>👥 Пользователи</b>',
    '',
    `Всего: ${stats.total} · можно писать: ${stats.allowed}`,
    `Запускали бота: ${stats.started} · согласие: ${stats.consented}`,
    '',
    '<b>Последние 10</b>',
  ];
  if (!recent.length) {
    lines.push('Пока нет пользователей.');
  } else {
    for (const u of recent) {
      const name = u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(' ') || 'без имени';
      const flags = [
        u.started_at ? 'start' : '',
        u.approved_at ? 'approved' : '',
        u.consent_broadcasts ? 'consent' : '',
      ].filter(Boolean).join(',');
      lines.push(`<code>${u.telegram_id}</code> ${escapeHtml(name)} — ${dmLabel(u)}${flags ? ` [${flags}]` : ''}`);
    }
  }

  await render(env, chatId, messageId, lines.join('\n'), {
    inline_keyboard: [
      [{ text: '🔄 Обновить', callback_data: 'menu:users' }],
      [{ text: '🔍 Найти по ID или @username', callback_data: 'users:search' }],
      backRow(),
    ],
  });
}

async function showSettings(env: Env, chatId: number, messageId?: number): Promise<void> {
  const rate = await getBroadcastRate(env.DB);
  const stats = await getStats(env.DB);
  const text =
    '<b>⚙️ Настройки</b>\n\n' +
    `Канал: <code>${escapeHtml(env.CHANNEL_ID)}</code>\n` +
    `Администраторы: <code>${getAdminIds(env).join(', ') || 'не заданы'}</code>\n` +
    `Скорость рассылки: <b>${rate} сообщений/сек</b>\n` +
    `Пользователей в базе: ${stats.total}\n` +
    `Очередь рассылок: ${env.BROADCAST_QUEUE ? 'подключена' : 'НЕ подключена'}\n` +
    `Секрет webhook админ-бота: ${env.ADMIN_WEBHOOK_SECRET ? 'включён' : 'не задан'}\n\n` +
    '<i>Токены в интерфейсе не отображаются.</i>';

  await render(env, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: '🚀 Скорость рассылки', callback_data: 'set:rate' }],
      [{ text: '🩺 Проверить Telegram и БД', callback_data: 'set:diag' }],
      backRow(),
    ],
  });
}

async function showLinks(env: Env, chatId: number, messageId?: number): Promise<void> {
  const links = await listLinks(env.DB);
  if (!links.length) {
    await render(
      env,
      chatId,
      messageId,
      '<b>🔗 Ссылки на каналы</b>\n\nСсылок пока нет. Добавьте первую ссылку — она станет доступна в приветствии и рассылках.',
      { inline_keyboard: [[{ text: '➕ Добавить ссылку', callback_data: 'link:add' }], backRow()] },
    );
    return;
  }

  const lines = ['<b>🔗 Ссылки на каналы</b>', ''];
  const rows: AdminButton[][] = [];
  for (const link of links) {
    lines.push(
      `${link.active ? '🟢' : '⚪️'} <b>${escapeHtml(link.title)}</b> — <code>${escapeHtml(link.slug)}</code>\n${escapeHtml(link.url)}`,
    );
    rows.push([
      { text: `✏️ ${truncate(link.title, 22)}`, callback_data: `link:edit:${link.id}` },
      { text: link.active ? '⏸' : '▶️', callback_data: `link:toggle:${link.id}` },
      { text: '🗑', callback_data: `link:del:${link.id}` },
    ]);
  }
  lines.push('', '<i>В тексте приветствия можно использовать {link:slug} — подставится актуальный URL.</i>');
  rows.push([{ text: '➕ Добавить ссылку', callback_data: 'link:add' }]);
  rows.push(backRow());

  await render(env, chatId, messageId, lines.join('\n'), { inline_keyboard: rows });
}

async function showLinkEdit(env: Env, chatId: number, id: number, messageId?: number): Promise<void> {
  const link = await getLink(env.DB, id);
  if (!link) {
    await showLinks(env, chatId, messageId);
    return;
  }
  const text =
    `<b>Ссылка «${escapeHtml(link.title)}»</b>\n\n` +
    `Slug: <code>${escapeHtml(link.slug)}</code>\n` +
    `URL: ${escapeHtml(link.url)}\n` +
    `Тип: ${escapeHtml(link.kind)}\n` +
    `Статус: ${link.active ? 'активна' : 'выключена'}\n\n` +
    'Slug используется в шаблонах вида <code>{link:main}</code> и в кнопках-ссылках.';

  await render(env, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: '✏️ Название', callback_data: `link:set:title:${link.id}` }],
      [{ text: '✏️ Slug', callback_data: `link:set:slug:${link.id}` }],
      [{ text: '✏️ URL', callback_data: `link:set:url:${link.id}` }],
      [{ text: '🔁 Тип', callback_data: `link:kind:${link.id}` }],
      [{ text: link.active ? '⏸ Выключить' : '▶️ Включить', callback_data: `link:toggle:${link.id}` }],
      [{ text: '🗑 Удалить', callback_data: `link:del:${link.id}` }],
      backRow('menu:links'),
    ],
  });
}

async function showWelcome(env: Env, chatId: number, messageId?: number): Promise<void> {
  const config = await getWelcomeConfig(env.DB);
  const linkMap = await getLinkMap(env.DB);
  const { buttons } = buildWelcomeContent(config, linkMap);
  const previewText =
    config.contentType === 'text'
      ? truncate(config.text ?? '', 700)
      : `${config.contentType === 'photo' ? '🖼 Фото' : '🎬 Видео'} + подпись:\n${truncate(config.caption ?? '(без подписи)', 700)}`;

  const text =
    '<b>💬 Приветственное сообщение</b>\n\n' +
    `Статус: ${config.enabled ? '🟢 включено' : '⚪️ выключено'}\n` +
    `Тип: ${config.contentType}\n` +
    `Форматирование: ${config.parseMode ?? 'без разметки'}\n` +
    `Кнопок: ${buttons.length}\n\n` +
    `<b>Текущий текст</b>\n${escapeHtml(previewText)}\n\n` +
    '<i>Отправляется сразу после одобрения заявки. Для пользователей, не запускавших бота, используется user_chat_id (ограниченное время).</i>';

  await render(env, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: config.enabled ? '⏸ Выключить' : '▶️ Включить', callback_data: 'wel:toggle' }],
      [{ text: '✏️ Текст', callback_data: 'wel:text' }],
      [{ text: '🖼 Фото', callback_data: 'wel:photo' }, { text: '🎬 Видео', callback_data: 'wel:video' }],
      [{ text: '✏️ Подпись к медиа', callback_data: 'wel:caption' }],
      [{ text: '🔤 HTML', callback_data: 'wel:fmt:HTML' }, { text: '🔤 MarkdownV2', callback_data: 'wel:fmt:MarkdownV2' }, { text: '🔤 Без', callback_data: 'wel:fmt:none' }],
      [{ text: '🔗 Кнопки', callback_data: 'wel:buttons' }],
      [{ text: '📤 Отправить тест себе', callback_data: 'wel:test' }],
      [{ text: '♻️ Сбросить к стандартному', callback_data: 'wel:reset' }],
      backRow(),
    ],
  });
}

function audienceKeyboard(counts: Record<AudienceSegment, number>): AdminKeyboard {
  const rows: AdminButton[][] = SEGMENT_ORDER.map((segment) => [
    {
      text: `${SEGMENT_LABELS[segment]} · ${counts[segment]}`,
      callback_data: `bc:aud:${segment}`,
    },
  ]);
  rows.push([{ text: '❌ Отмена', callback_data: 'bc:cancel' }]);
  return { inline_keyboard: rows };
}

async function showAudience(env: Env, chatId: number, messageId: number | undefined, composer: ComposerData): Promise<void> {
  const adminIds = getAdminIds(env);
  const entries = await Promise.all(
    SEGMENT_ORDER.map(async (segment) => [segment, await countAudience(env.DB, segment, adminIds)] as const),
  );
  const counts = Object.fromEntries(entries) as Record<AudienceSegment, number>;

  await render(
    env,
    chatId,
    messageId,
    '<b>🎯 Выберите аудиторию</b>\n\n' +
      'Сегменты не смешиваются. Для маркетинговой рассылки используйте сегмент «Согласившиеся на рассылки».',
    audienceKeyboard(counts),
  );
}

async function showPreview(
  env: Env,
  chatId: number,
  messageId: number | undefined,
  composer: ComposerData,
): Promise<void> {
  if (!composer.content || !composer.audience) {
    await showMainMenu(env, chatId, messageId);
    return;
  }

  const linkMap = await getLinkMap(env.DB);
  const buttons =
    composer.buttons && composer.buttons.length
      ? composer.buttons
          .map((b) => {
            const url = b.url || (b.link ? linkMap[b.link]?.url : '');
            return { text: b.text, url: url ?? '' };
          })
          .filter((b) => b.url)
      : [];

  const preview = await sendContent(adminToken(env), chatId, composer.content, buttons, { retries: 1 });
  if (!preview.result.ok) {
    await render(
      env,
      chatId,
      messageId,
      `<b>Ошибка предпросмотра</b>\n\n<code>${escapeHtml(preview.result.description ?? 'unknown')}</code>\n\n` +
        'Проверьте форматирование и содержимое.',
      { inline_keyboard: [[{ text: '✏️ Изменить', callback_data: 'bc:edit' }], [{ text: '❌ Отмена', callback_data: 'bc:cancel' }]] },
    );
    return;
  }

  const adminIds = getAdminIds(env);
  const total = await countAudience(env.DB, composer.audience, adminIds);
  const noConsent = await countAudienceWithoutConsent(env.DB, composer.audience, adminIds);
  const warn = noConsent > 0 && composer.audience !== 'consented' && composer.audience !== 'test';

  const text =
    '<b>👁 Предпросмотр отправлен выше</b>\n\n' +
    `Аудитория: <b>${escapeHtml(SEGMENT_LABELS[composer.audience])}</b>\n` +
    `Получателей: <b>${total}</b>\n` +
    `Без согласия на рассылку: <b>${noConsent}</b>\n` +
    `Кнопок: ${buttons.length}\n` +
    `Контент: ${contentSummary(composer.content)}\n` +
    (warn
      ? '\n⚠️ <b>Внимание:</b> в выбранной аудитории есть пользователи без согласия. Telegram-рассылку можно запускать только при наличии законного основания.'
      : '') +
    '\n\n<i>Нажмите «Запустить», чтобы создать рассылку. Отправка продолжится в очереди Cloudflare.</i>';

  await render(env, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: warn ? '✅ Подтвердить и запустить' : '✅ Запустить', callback_data: 'bc:go' }],
      [{ text: '✏️ Изменить', callback_data: 'bc:edit' }],
      [{ text: '❌ Отмена', callback_data: 'bc:cancel' }],
    ],
  });
}

async function createBroadcastFromComposer(
  env: Env,
  chatId: number,
  adminId: number,
  composer: ComposerData,
): Promise<void> {
  if (!composer.content || !composer.audience) {
    await notify(env, chatId, 'Черновик рассылки потерян. Начните заново.', {
      inline_keyboard: [[{ text: '📢 Создать рассылку', callback_data: 'menu:bc_new' }]],
    });
    return;
  }

  const rate = await getBroadcastRate(env.DB);
  const name = `Рассылка ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;
  const id = await createBroadcast(env.DB, {
    adminId,
    name,
    contentType: composer.content.contentType,
    text: composer.content.contentType === 'text' ? composer.content.text ?? '' : null,
    caption: composer.content.contentType === 'text' ? null : composer.content.caption ?? '',
    fileId: composer.content.fileId ?? null,
    parseMode: composer.content.parseMode ?? null,
    buttonsJson: JSON.stringify(composer.buttons ?? []),
    audience: composer.audience,
    ratePerSec: rate,
    adminIds: getAdminIds(env),
  });

  const b = await getBroadcast(env.DB, id);
  await clearSession(env.DB, adminId);

  try {
    if (b && b.total > 0) {
      await env.BROADCAST_QUEUE.send({ type: 'broadcast', broadcastId: id, cursor: 0 });
    }
  } catch (err) {
    console.error(`BROADCAST enqueue failed id=${id}`, err);
    await notify(
      env,
      chatId,
      `Рассылка #${id} создана, но не удалось поставить её в очередь. Нажмите «Возобновить» в карточке рассылки.`,
    );
  }

  await notify(
    env,
    chatId,
    `<b>✅ Рассылка #${id} создана</b>\n\n` +
      `Аудитория: ${escapeHtml(SEGMENT_LABELS[composer.audience])}\n` +
      `Получателей: ${b?.total ?? 0}\n` +
      `Скорость: ${rate}/сек\n\n` +
      (b && b.total === 0 ? '⚠️ В выбранной аудитории нет получателей.' : 'Отправка выполняется в фоне.'),
    {
      inline_keyboard: [
        [{ text: '📊 Открыть рассылку', callback_data: `bc:detail:${id}` }],
        [{ text: '📋 Все рассылки', callback_data: 'menu:bc_list' }],
      ],
    },
  );
}

async function showButtonsMenu(
  env: Env,
  chatId: number,
  messageId: number | undefined,
  mode: 'broadcast' | 'welcome',
  buttons: StoredButton[],
  prefix: 'bc' | 'wel',
): Promise<void> {
  const linkMap = await getLinkMap(env.DB);
  const lines = ['<b>🔗 Inline-кнопки</b>', ''];
  if (!buttons.length) {
    lines.push('Кнопок пока нет.');
  } else {
    buttons.forEach((b, index) => {
      const url = b.url || (b.link ? linkMap[b.link]?.url : '');
      lines.push(`${index + 1}. <b>${escapeHtml(b.text)}</b> → ${escapeHtml(url || `{link:${b.link ?? '?'}}`)}`);
    });
  }
  lines.push('', 'До 12 кнопок. URL-кнопки должны вести на http(s) или tg://.');

  const rows: AdminButton[][] = [];
  if (buttons.length) {
    rows.push(
      buttons.map((b, index) => ({
        text: `❌ ${index + 1}`,
        callback_data: `${prefix}:btn:rm:${index}`,
      })),
    );
  }
  rows.push([
    { text: '➕ URL-кнопка', callback_data: `${prefix}:btn:add_url` },
    { text: '🔗 Из ссылок', callback_data: `${prefix}:btn:add_link` },
  ]);
  if (buttons.length) rows.push([{ text: '🗑 Очистить', callback_data: `${prefix}:btn:clear` }]);
  rows.push([{ text: '✅ Готово', callback_data: `${prefix}:btn:done` }]);

  await render(env, chatId, messageId, lines.join('\n'), { inline_keyboard: rows });
}

async function showLinkPicker(
  env: Env,
  chatId: number,
  messageId: number | undefined,
  prefix: 'bc' | 'wel',
): Promise<void> {
  const links = await listLinks(env.DB, true);
  const rows: AdminButton[][] = links.map((link) => [
    { text: `${link.title}`, callback_data: `${prefix}:btn:link:${link.slug}` },
  ]);
  rows.push([{ text: '⬅️ Назад', callback_data: prefix === 'bc' ? 'bc:btn:back' : 'wel:btn:back' }]);
  await render(
    env,
    chatId,
    messageId,
    links.length
      ? '<b>Выберите ссылку</b>\n\nКнопка будет хранить ссылку на slug, поэтому изменения URL подхватятся автоматически.'
      : '<b>Ссылок нет</b>\n\nСначала добавьте ссылку в разделе «🔗 Ссылки на каналы».',
    { inline_keyboard: rows },
  );
}

async function runDiagnostics(env: Env, chatId: number): Promise<void> {
  const mainToken = getMainToken(env);
  const adminTokenValue = adminToken(env);
  const lines = ['<b>🩺 Диагностика</b>', ''];
  const checks: Array<[string, Promise<import('./telegram').TgResult>]> = [
    ['main getMe', tgCall(mainToken, 'getMe')],
    ['main webhook', tgCall(mainToken, 'getWebhookInfo')],
    ['admin getMe', tgCall(adminTokenValue, 'getMe')],
    ['admin webhook', tgCall(adminTokenValue, 'getWebhookInfo')],
    ['channel', tgCall(mainToken, 'getChat', { chat_id: env.CHANNEL_ID })],
  ];

  for (const [label, promise] of checks) {
    const res = await promise;
    if (res.ok) {
      const result = res.result as Record<string, unknown> | undefined;
      if (label.endsWith('getMe')) {
        lines.push(`✅ ${label}: @${escapeHtml(String(result?.username ?? '?'))}`);
      } else if (label.endsWith('webhook')) {
        lines.push(`✅ ${label}: ${escapeHtml(truncate(String(result?.url ?? 'не установлен'), 90))}`);
      } else {
        lines.push(`✅ ${label}: ${escapeHtml(String(result?.title ?? result?.id ?? 'ok'))}`);
      }
    } else {
      lines.push(`❌ ${label}: ${escapeHtml(truncate(res.description ?? 'unknown', 160))}`);
    }
  }

  try {
    const stats = await getStats(env.DB);
    lines.push(`✅ D1: ${stats.total} пользователей, ${stats.allowed} доступны для сообщений`);
  } catch (err) {
    lines.push(`❌ D1: ${escapeHtml(err instanceof Error ? err.message : String(err))}`);
  }
  lines.push(`✅ Очередь: ${env.BROADCAST_QUEUE ? 'binding доступен' : 'НЕ НАСТРОЕН'}`);

  await sendText(adminTokenValue, chatId, lines.join('\n'), {
    inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu:settings' }]],
  });
}

async function handleAdminMessage(env: Env, message: TelegramMessage): Promise<void> {
  const from = message.from;
  if (!from) return;
  const chatId = message.chat.id;
  const token = adminToken(env);

  if (!isAdmin(env, from.id)) {
    console.warn(`ADMIN access denied user=${from.id} @${from.username ?? '?'}`);
    await sendText(token, chatId, '⛔️ Доступ запрещён. Этот бот предназначен только для администраторов.');
    return;
  }

  const text = (message.text ?? '').trim();
  if (text.startsWith('/')) {
    const command = text.split(/\s+/)[0].toLowerCase();
    if (command === '/start' || command === '/menu') {
      await clearSession(env.DB, from.id);
      await showMainMenu(env, chatId);
      return;
    }
    if (command === '/cancel') {
      await clearSession(env.DB, from.id);
      await notify(env, chatId, 'Действие отменено.', { inline_keyboard: [backRow()] });
      return;
    }
    if (command === '/stats') return showStats(env, chatId);
    if (command === '/broadcast') {
      await clearSession(env.DB, from.id);
      return startBroadcastComposer(env, chatId, from.id);
    }
    if (command === '/links') return showLinks(env, chatId);
    if (command === '/welcome') return showWelcome(env, chatId);
    if (command === '/users') return showUsers(env, chatId);
    if (command === '/settings') return showSettings(env, chatId);
    if (command === '/id' || command === '/chat_id') {
      await notify(env, chatId, `Ваш Telegram ID: <code>${from.id}</code>\nChat ID: <code>${chatId}</code>`);
      return;
    }
    await notify(env, chatId, 'Неизвестная команда. Откройте /menu.');
    return;
  }

  const session = await getSession(env.DB, from.id);
  if (!session) {
    await notify(env, chatId, 'Выберите действие в меню.', menuKeyboard());
    return;
  }

  const data = session.data;

  switch (session.state) {
    case 'bc_content': {
      const composer = composerFromSession(session);
      const contentType = composer.contentType ?? 'text';
      const extracted = contentFromMessage(message, contentType);
      if (!extracted.content) {
        await notify(env, chatId, `⚠️ ${escapeHtml(extracted.error ?? 'Неверный контент')}\n\nОтправьте контент ещё раз или /cancel.`);
        return;
      }
      const next: ComposerData = { ...composer, content: extracted.content };
      await setSession(env.DB, from.id, { state: 'bc_format', data: next as unknown as Record<string, unknown> });
      await notify(
        env,
        chatId,
        '<b>🔤 Выберите форматирование</b>\n\nHTML или MarkdownV2 применяются к тексту/подписи. Если не уверены — выберите «Без разметки».',
        {
          inline_keyboard: [
            [{ text: 'HTML', callback_data: 'bc:fmt:HTML' }],
            [{ text: 'MarkdownV2', callback_data: 'bc:fmt:MarkdownV2' }],
            [{ text: 'Без разметки', callback_data: 'bc:fmt:none' }],
            [{ text: '❌ Отмена', callback_data: 'bc:cancel' }],
          ],
        },
      );
      return;
    }

    case 'bc_btn_text': {
      const composer = composerFromSession(session);
      if (!text) {
        await notify(env, chatId, 'Текст кнопки не может быть пустым. Отправьте текст или /cancel.');
        return;
      }
      await setSession(env.DB, from.id, {
        state: 'bc_btn_url',
        data: { ...composer, pendingButtonText: truncate(text, 64) } as unknown as Record<string, unknown>,
      });
      await notify(env, chatId, 'Отправьте URL кнопки (http://, https:// или tg://).');
      return;
    }

    case 'bc_btn_url': {
      const composer = composerFromSession(session) as ComposerData & { pendingButtonText?: string };
      if (!/^(https?:\/\/|tg:\/\/)/i.test(text)) {
        await notify(env, chatId, 'URL должен начинаться с http://, https:// или tg://. Попробуйте снова.');
        return;
      }
      const buttons = [...(composer.buttons ?? []), { text: composer.pendingButtonText ?? 'Кнопка', url: text }];
      const next: ComposerData = { contentType: composer.contentType, content: composer.content, buttons };
      await setSession(env.DB, from.id, { state: 'bc_buttons', data: next as unknown as Record<string, unknown> });
      await showButtonsMenu(env, chatId, undefined, 'broadcast', buttons, 'bc');
      return;
    }

    case 'wel_text': {
      const config = await getWelcomeConfig(env.DB);
      await setWelcomeConfig(env.DB, { ...config, contentType: 'text', text, parseMode: config.parseMode ?? 'HTML' }, from.id);
      await clearSession(env.DB, from.id);
      await notify(env, chatId, '✅ Текст приветствия обновлён.');
      await showWelcome(env, chatId);
      return;
    }

    case 'wel_caption': {
      const config = await getWelcomeConfig(env.DB);
      await setWelcomeConfig(env.DB, { ...config, caption: text }, from.id);
      await clearSession(env.DB, from.id);
      await notify(env, chatId, '✅ Подпись обновлена.');
      await showWelcome(env, chatId);
      return;
    }

    case 'wel_media': {
      const mediaType = String(data.mediaType ?? 'photo') as 'photo' | 'video';
      const extracted = contentFromMessage(message, mediaType);
      if (!extracted.content) {
        await notify(env, chatId, `⚠️ ${escapeHtml(extracted.error ?? 'Неверный контент')}`);
        return;
      }
      const config = await getWelcomeConfig(env.DB);
      await setWelcomeConfig(
        env.DB,
        { ...config, contentType: mediaType, fileId: extracted.content.fileId, caption: extracted.content.caption ?? '' },
        from.id,
      );
      await clearSession(env.DB, from.id);
      await notify(env, chatId, `✅ Приветствие теперь отправляется как ${mediaType === 'photo' ? 'фото' : 'видео'}.`);
      await showWelcome(env, chatId);
      return;
    }

    case 'wel_btn_text': {
      if (!text) {
        await notify(env, chatId, 'Текст кнопки не может быть пустым.');
        return;
      }
      await setSession(env.DB, from.id, { state: 'wel_btn_url', data: { pendingButtonText: truncate(text, 64) } });
      await notify(env, chatId, 'Отправьте URL кнопки (http://, https:// или tg://).');
      return;
    }

    case 'wel_btn_url': {
      if (!/^(https?:\/\/|tg:\/\/)/i.test(text)) {
        await notify(env, chatId, 'URL должен начинаться с http://, https:// или tg://.');
        return;
      }
      const config = await getWelcomeConfig(env.DB);
      const buttons = [...(config.buttons ?? []), { text: String(data.pendingButtonText ?? 'Кнопка'), url: text }];
      await setWelcomeConfig(env.DB, { ...config, buttons }, from.id);
      await setSession(env.DB, from.id, { state: 'wel_buttons', data: {} });
      await showButtonsMenu(env, chatId, undefined, 'welcome', buttons, 'wel');
      return;
    }

    case 'link_title': {
      if (!text) {
        await notify(env, chatId, 'Название не может быть пустым.');
        return;
      }
      await setSession(env.DB, from.id, { state: 'link_slug', data: { title: text } });
      await notify(env, chatId, 'Введите slug: латиница, цифры, _ и - (например, main или extra-channel).');
      return;
    }

    case 'link_slug': {
      const slug = text.toLowerCase();
      if (!/^[a-z0-9_-]{1,32}$/.test(slug)) {
        await notify(env, chatId, 'Некорректный slug. Разрешены a-z, 0-9, _ и -, до 32 символов.');
        return;
      }
      await setSession(env.DB, from.id, { state: 'link_url', data: { title: String(data.title ?? ''), slug } });
      await notify(env, chatId, 'Отправьте URL канала (https://t.me/...).');
      return;
    }

    case 'link_url': {
      if (!/^https?:\/\//i.test(text)) {
        await notify(env, chatId, 'URL должен начинаться с http:// или https://.');
        return;
      }
      try {
        const id = await createLink(env.DB, {
          title: String(data.title ?? 'Канал'),
          slug: String(data.slug ?? 'link'),
          url: text,
        });
        await clearSession(env.DB, from.id);
        await notify(env, chatId, `✅ Ссылка создана (ID ${id}).`);
        await showLinks(env, chatId);
      } catch (err) {
        await notify(env, chatId, `⚠️ Не удалось сохранить: ${escapeHtml(err instanceof Error ? err.message : String(err))}`);
      }
      return;
    }

    case 'link_edit_value': {
      const id = Number(data.id ?? 0);
      const field = String(data.field ?? '');
      const link = await getLink(env.DB, id);
      if (!link) {
        await clearSession(env.DB, from.id);
        await showLinks(env, chatId);
        return;
      }
      if (field === 'slug') {
        const slug = text.toLowerCase();
        if (!/^[a-z0-9_-]{1,32}$/.test(slug)) {
          await notify(env, chatId, 'Некорректный slug. Разрешены a-z, 0-9, _ и -, до 32 символов.');
          return;
        }
        await updateLink(env.DB, id, { slug });
      } else if (field === 'url') {
        if (!/^https?:\/\//i.test(text)) {
          await notify(env, chatId, 'URL должен начинаться с http:// или https://.');
          return;
        }
        await updateLink(env.DB, id, { url: text });
      } else {
        if (!text) {
          await notify(env, chatId, 'Значение не может быть пустым.');
          return;
        }
        await updateLink(env.DB, id, { title: text });
      }
      await clearSession(env.DB, from.id);
      await notify(env, chatId, '✅ Ссылка обновлена.');
      await showLinkEdit(env, chatId, id);
      return;
    }

    case 'user_search': {
      const user = await findUser(env.DB, text);
      await clearSession(env.DB, from.id);
      if (!user) {
        await notify(env, chatId, 'Пользователь не найден.', { inline_keyboard: [backRow('menu:users')] });
        return;
      }
      const name = user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(' ');
      await notify(
        env,
        chatId,
        `<b>Пользователь</b>\n\n` +
          `ID: <code>${user.telegram_id}</code>\n` +
          `Имя: ${escapeHtml(name || '—')}\n` +
          `Личные сообщения: ${dmLabel(user)}\n` +
          `Запускал бота: ${formatDate(user.started_at)}\n` +
          `Заявка: ${formatDate(user.join_requested_at)}\n` +
          `Одобрен: ${formatDate(user.approved_at)}\n` +
          `Согласие: ${user.consent_broadcasts ? `да (${formatDate(user.consent_at)})` : 'нет'}\n` +
          `Ошибка: ${escapeHtml(user.last_error ?? '—')}`,
        { inline_keyboard: [backRow('menu:users')] },
      );
      return;
    }

    case 'set_rate': {
      const rate = Number(text);
      if (!Number.isFinite(rate) || rate < 1 || rate > 28) {
        await notify(env, chatId, 'Введите число от 1 до 28 сообщений в секунду.');
        return;
      }
      await setBroadcastRate(env.DB, rate, from.id);
      await clearSession(env.DB, from.id);
      await notify(env, chatId, `✅ Скорость установлена: ${Math.floor(rate)}/сек.`);
      await showSettings(env, chatId);
      return;
    }

    default:
      await clearSession(env.DB, from.id);
      await notify(env, chatId, 'Состояние сброшено. Откройте /menu.');
  }
}

async function startBroadcastComposer(env: Env, chatId: number, adminId: number): Promise<void> {
  await notify(
    env,
    chatId,
    '<b>📢 Новая рассылка</b>\n\nШаг 1. Выберите тип контента.',
    {
      inline_keyboard: [
        [{ text: '📝 Текст', callback_data: 'bc:type:text' }],
        [{ text: '🖼 Фото', callback_data: 'bc:type:photo' }],
        [{ text: '🎬 Видео', callback_data: 'bc:type:video' }],
        [{ text: '❌ Отмена', callback_data: 'bc:cancel' }],
      ],
    },
  );
  await setSession(env.DB, adminId, { state: 'bc_start', data: {} });
}

async function handleAdminCallback(env: Env, query: TelegramCallbackQuery): Promise<void> {
  const from = query.from;
  const token = adminToken(env);
  const data = query.data ?? '';
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;

  if (!isAdmin(env, from.id)) {
    console.warn(`ADMIN callback denied user=${from.id} @${from.username ?? '?'}`);
    await answerCallback(token, query.id, 'Доступ запрещён', true);
    return;
  }

  if (!chatId) {
    await answerCallback(token, query.id);
    return;
  }

  await answerCallback(token, query.id);
  const session = await getSession(env.DB, from.id);

  if (data === 'menu:main') {
    await clearSession(env.DB, from.id);
    return showMainMenu(env, chatId, messageId);
  }
  if (data === 'menu:stats') return showStats(env, chatId, messageId);
  if (data === 'menu:bc_new') {
    await clearSession(env.DB, from.id);
    return startBroadcastComposer(env, chatId, from.id);
  }
  if (data === 'menu:bc_list') return showBroadcastList(env, chatId, messageId);
  if (data === 'menu:links') return showLinks(env, chatId, messageId);
  if (data === 'menu:welcome') return showWelcome(env, chatId, messageId);
  if (data === 'menu:users') return showUsers(env, chatId, messageId);
  if (data === 'menu:settings') return showSettings(env, chatId, messageId);
  if (data === 'users:search') {
    await setSession(env.DB, from.id, { state: 'user_search', data: {} });
    return render(env, chatId, messageId, '<b>🔍 Поиск пользователя</b>\n\nОтправьте Telegram ID или @username.', {
      inline_keyboard: [backRow('menu:users')],
    });
  }

  // ------------------------------------------------------------- broadcast composer
  if (data === 'bc:cancel' || data === 'bc:edit') {
    await clearSession(env.DB, from.id);
    if (data === 'bc:edit') return startBroadcastComposer(env, chatId, from.id);
    return showMainMenu(env, chatId, messageId);
  }

  if (data.startsWith('bc:type:')) {
    const contentType = data.slice('bc:type:'.length) as ContentType;
    const composer: ComposerData = { contentType, buttons: [] };
    await setSession(env.DB, from.id, { state: 'bc_content', data: { contentType } });
    const prompt =
      contentType === 'text'
        ? 'Отправьте текст рассылки одним сообщением.'
        : contentType === 'photo'
          ? 'Отправьте фотографию. Подпись из сообщения будет использована как текст.'
          : 'Отправьте видео. Подпись из сообщения будет использована как текст.';
    return render(env, chatId, messageId, `<b>Шаг 2. Контент</b>\n\n${prompt}\n\nДля отмены: /cancel`, {
      inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'bc:cancel' }]],
    });
  }

  if (data.startsWith('bc:fmt:')) {
    if (!session) return showMainMenu(env, chatId, messageId);
    const composer = composerFromSession(session);
    if (!composer.content) return showMainMenu(env, chatId, messageId);
    const mode = data.slice('bc:fmt:'.length);
    composer.content.parseMode = mode === 'none' ? null : mode;
    await setSession(env.DB, from.id, { state: 'bc_buttons', data: composer as unknown as Record<string, unknown> });
    return showButtonsMenu(env, chatId, messageId, 'broadcast', composer.buttons ?? [], 'bc');
  }

  if (data.startsWith('bc:btn:')) {
    if (!session) return showMainMenu(env, chatId, messageId);
    const composer = composerFromSession(session);
    const action = data.slice('bc:btn:'.length);
    const buttons = composer.buttons ?? [];

    if (action === 'add_url') {
      await setSession(env.DB, from.id, { state: 'bc_btn_text', data: composer as unknown as Record<string, unknown> });
      return render(env, chatId, messageId, 'Отправьте текст кнопки (до 64 символов).', {
        inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'bc:btn:back' }]],
      });
    }
    if (action === 'add_link') return showLinkPicker(env, chatId, messageId, 'bc');
    if (action === 'back') {
      return showButtonsMenu(env, chatId, messageId, 'broadcast', buttons, 'bc');
    }
    if (action.startsWith('link:')) {
      const slug = action.slice('link:'.length);
      const link = await getLinkMap(env.DB);
      const found = link[slug];
      if (!found) {
        return render(env, chatId, messageId, 'Ссылка не найдена.', {
          inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'bc:btn:add_link' }]],
        });
      }
      const next = [...buttons, { text: found.title, link: slug }];
      const updated: ComposerData = { ...composer, buttons: next };
      await setSession(env.DB, from.id, { state: 'bc_buttons', data: updated as unknown as Record<string, unknown> });
      return showButtonsMenu(env, chatId, messageId, 'broadcast', next, 'bc');
    }
    if (action === 'clear') {
      const updated: ComposerData = { ...composer, buttons: [] };
      await setSession(env.DB, from.id, { state: 'bc_buttons', data: updated as unknown as Record<string, unknown> });
      return showButtonsMenu(env, chatId, messageId, 'broadcast', [], 'bc');
    }
    if (action.startsWith('rm:')) {
      const index = Number(action.slice('rm:'.length));
      const next = buttons.filter((_b, i) => i !== index);
      const updated: ComposerData = { ...composer, buttons: next };
      await setSession(env.DB, from.id, { state: 'bc_buttons', data: updated as unknown as Record<string, unknown> });
      return showButtonsMenu(env, chatId, messageId, 'broadcast', next, 'bc');
    }
    if (action === 'done') {
      return showAudience(env, chatId, messageId, composer);
    }
    return showButtonsMenu(env, chatId, messageId, 'broadcast', buttons, 'bc');
  }

  if (data.startsWith('bc:aud:')) {
    if (!session) return showMainMenu(env, chatId, messageId);
    const composer = composerFromSession(session);
    const segment = data.slice('bc:aud:'.length) as AudienceSegment;
    if (!SEGMENT_ORDER.includes(segment)) return showAudience(env, chatId, messageId, composer);
    composer.audience = segment;
    composer.confirmed = false;
    await setSession(env.DB, from.id, { state: 'bc_preview', data: composer as unknown as Record<string, unknown> });
    return showPreview(env, chatId, messageId, composer);
  }

  if (data === 'bc:go' || data === 'bc:go_confirm') {
    if (!session) return showMainMenu(env, chatId, messageId);
    const composer = composerFromSession(session);
    if (!composer.content || !composer.audience) return showMainMenu(env, chatId, messageId);

    if (data === 'bc:go') {
      const noConsent = await countAudienceWithoutConsent(env.DB, composer.audience, getAdminIds(env));
      const needsConfirm = noConsent > 0 && composer.audience !== 'consented' && composer.audience !== 'test';
      if (needsConfirm && !composer.confirmed) {
        composer.confirmed = true;
        await setSession(env.DB, from.id, { state: 'bc_preview', data: composer as unknown as Record<string, unknown> });
        return render(
          env,
          chatId,
          messageId,
          `⚠️ <b>Подтверждение</b>\n\nВ аудитории ${noConsent} пользователей без согласия на рассылку.\n\n` +
            'Нажмите кнопку ниже, только если у вас есть законное основание для отправки (например, заявка на вступление/явное согласие).',
          {
            inline_keyboard: [
              [{ text: '✅ Подтверждаю запуск', callback_data: 'bc:go_confirm' }],
              [{ text: '❌ Отмена', callback_data: 'bc:cancel' }],
            ],
          },
        );
      }
    }
    return createBroadcastFromComposer(env, chatId, from.id, composer);
  }

  if (data.startsWith('bc:detail:') || data.startsWith('bc:pause:') || data.startsWith('bc:resume:') || data.startsWith('bc:stop') || data.startsWith('bc:stopc:')) {
    const parts = data.split(':');
    const action = parts[1];
    const id = Number(parts[2] ?? 0);
    if (!id) return showBroadcastList(env, chatId, messageId);

    if (action === 'pause') {
      const ok = await pauseBroadcast(env.DB, id);
      await notify(env, chatId, ok ? '⏸ Рассылка приостановлена.' : 'Нельзя приостановить в текущем статусе.');
      return showBroadcastDetail(env, chatId, id, messageId);
    }
    if (action === 'resume') {
      const ok = await resumeBroadcast(env.DB, id);
      if (ok) {
        try {
          await env.BROADCAST_QUEUE.send({ type: 'broadcast-kick', broadcastId: id });
        } catch (err) {
          console.error(`BROADCAST resume enqueue failed id=${id}`, err);
        }
      }
      await notify(env, chatId, ok ? '▶️ Рассылка возобновлена.' : 'Нельзя возобновить в текущем статусе.');
      return showBroadcastDetail(env, chatId, id, messageId);
    }
    if (action === 'stopc') {
      return render(
        env,
        chatId,
        messageId,
        `<b>Остановить рассылку #${id}?</b>\n\nНепрошедшие получатели будут помечены как пропущенные. Действие необратимо.`,
        {
          inline_keyboard: [
            [{ text: '⏹ Да, остановить', callback_data: `bc:stop:${id}` }],
            [{ text: '⬅️ Назад', callback_data: `bc:detail:${id}` }],
          ],
        },
      );
    }
    if (action === 'stop') {
      const ok = await stopBroadcast(env.DB, id);
      await notify(env, chatId, ok ? '⏹ Рассылка остановлена.' : 'Нельзя остановить в текущем статусе.');
      return showBroadcastDetail(env, chatId, id, messageId);
    }
    return showBroadcastDetail(env, chatId, id, messageId);
  }

  // ------------------------------------------------------------- welcome
  if (data === 'wel:toggle') {
    const config = await getWelcomeConfig(env.DB);
    await setWelcomeConfig(env.DB, { ...config, enabled: !config.enabled }, from.id);
    return showWelcome(env, chatId, messageId);
  }
  if (data === 'wel:text') {
    await setSession(env.DB, from.id, { state: 'wel_text', data: {} });
    return render(env, chatId, messageId, 'Отправьте новый текст приветствия.\n\nМожно использовать HTML и {link:slug}.', {
      inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu:welcome' }]],
    });
  }
  if (data === 'wel:photo' || data === 'wel:video') {
    const mediaType = data.endsWith('photo') ? 'photo' : 'video';
    await setSession(env.DB, from.id, { state: 'wel_media', data: { mediaType } });
    return render(
      env,
      chatId,
      messageId,
      mediaType === 'photo'
        ? 'Отправьте фотографию для приветствия (подпись можно задать отдельно).'
        : 'Отправьте видео для приветствия (подпись можно задать отдельно).',
      { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu:welcome' }]] },
    );
  }
  if (data === 'wel:caption') {
    await setSession(env.DB, from.id, { state: 'wel_caption', data: {} });
    return render(env, chatId, messageId, 'Отправьте подпись к медиа (до 1024 символов).', {
      inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu:welcome' }]],
    });
  }
  if (data.startsWith('wel:fmt:')) {
    const config = await getWelcomeConfig(env.DB);
    const mode = data.slice('wel:fmt:'.length);
    await setWelcomeConfig(env.DB, { ...config, parseMode: mode === 'none' ? null : mode }, from.id);
    return showWelcome(env, chatId, messageId);
  }
  if (data === 'wel:reset') {
    return render(
      env,
      chatId,
      messageId,
      'Сбросить приветствие к стандартному тексту и кнопкам?',
      {
        inline_keyboard: [
          [{ text: '♻️ Да, сбросить', callback_data: 'wel:reset_confirm' }],
          [{ text: '⬅️ Назад', callback_data: 'menu:welcome' }],
        ],
      },
    );
  }
  if (data === 'wel:reset_confirm') {
    await setWelcomeConfig(env.DB, { ...DEFAULT_WELCOME }, from.id);
    await notify(env, chatId, '✅ Приветствие сброшено к стандартному.');
    return showWelcome(env, chatId, messageId);
  }
  if (data === 'wel:test') {
    return sendWelcomeTest(env, chatId);
  }
  if (data === 'wel:buttons') {
    const config = await getWelcomeConfig(env.DB);
    await setSession(env.DB, from.id, { state: 'wel_buttons', data: {} });
    return showButtonsMenu(env, chatId, messageId, 'welcome', config.buttons ?? [], 'wel');
  }
  if (data.startsWith('wel:btn:')) {
    const config = await getWelcomeConfig(env.DB);
    const action = data.slice('wel:btn:'.length);
    const buttons = config.buttons ?? [];

    if (action === 'add_url') {
      await setSession(env.DB, from.id, { state: 'wel_btn_text', data: {} });
      return render(env, chatId, messageId, 'Отправьте текст кнопки (до 64 символов).', {
        inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu:welcome' }]],
      });
    }
    if (action === 'add_link') return showLinkPicker(env, chatId, messageId, 'wel');
    if (action === 'back') return showButtonsMenu(env, chatId, messageId, 'welcome', buttons, 'wel');
    if (action.startsWith('link:')) {
      const slug = action.slice('link:'.length);
      const linkMap = await getLinkMap(env.DB);
      const found = linkMap[slug];
      if (!found) return showLinkPicker(env, chatId, messageId, 'wel');
      const next = [...buttons, { text: found.title, link: slug }];
      await setWelcomeConfig(env.DB, { ...config, buttons: next }, from.id);
      return showButtonsMenu(env, chatId, messageId, 'welcome', next, 'wel');
    }
    if (action === 'clear') {
      await setWelcomeConfig(env.DB, { ...config, buttons: [] }, from.id);
      return showButtonsMenu(env, chatId, messageId, 'welcome', [], 'wel');
    }
    if (action.startsWith('rm:')) {
      const index = Number(action.slice('rm:'.length));
      const next = buttons.filter((_b, i) => i !== index);
      await setWelcomeConfig(env.DB, { ...config, buttons: next }, from.id);
      return showButtonsMenu(env, chatId, messageId, 'welcome', next, 'wel');
    }
    if (action === 'done') {
      await clearSession(env.DB, from.id);
      return showWelcome(env, chatId, messageId);
    }
    return showButtonsMenu(env, chatId, messageId, 'welcome', buttons, 'wel');
  }

  // ------------------------------------------------------------- links
  if (data === 'link:add') {
    await setSession(env.DB, from.id, { state: 'link_title', data: {} });
    return render(env, chatId, messageId, '<b>Новая ссылка</b>\n\nВведите название (например, «Дополнительный канал»).', {
      inline_keyboard: [backRow('menu:links')],
    });
  }
  if (data.startsWith('link:edit:')) {
    return showLinkEdit(env, chatId, Number(data.slice('link:edit:'.length)), messageId);
  }
  if (data.startsWith('link:toggle:')) {
    const id = Number(data.slice('link:toggle:'.length));
    const link = await getLink(env.DB, id);
    if (link) await updateLink(env.DB, id, { active: link.active ? 0 : 1 });
    return showLinks(env, chatId, messageId);
  }
  if (data.startsWith('link:del:')) {
    const id = Number(data.slice('link:del:'.length));
    const link = await getLink(env.DB, id);
    if (!link) return showLinks(env, chatId, messageId);
    return render(
      env,
      chatId,
      messageId,
      `<b>Удалить ссылку «${escapeHtml(link.title)}»?</b>\n\nКнопки, которые ссылаются на slug <code>${escapeHtml(link.slug)}</code>, перестанут отображаться.`,
      {
        inline_keyboard: [
          [{ text: '🗑 Удалить', callback_data: `link:delc:${id}` }],
          [{ text: '⬅️ Назад', callback_data: `link:edit:${id}` }],
        ],
      },
    );
  }
  if (data.startsWith('link:delc:')) {
    await deleteLink(env.DB, Number(data.slice('link:delc:'.length)));
    await notify(env, chatId, '🗑 Ссылка удалена.');
    return showLinks(env, chatId, messageId);
  }
  if (data.startsWith('link:set:')) {
    const [, , field, rawId] = data.split(':');
    const id = Number(rawId);
    const link = await getLink(env.DB, id);
    if (!link) return showLinks(env, chatId, messageId);
    await setSession(env.DB, from.id, { state: 'link_edit_value', data: { id, field } });
    const prompt =
      field === 'title' ? 'Введите новое название.' : field === 'slug' ? 'Введите новый slug.' : 'Введите новый URL.';
    return render(env, chatId, messageId, prompt, {
      inline_keyboard: [[{ text: '⬅️ Назад', callback_data: `link:edit:${id}` }]],
    });
  }
  if (data.startsWith('link:kind:')) {
    const id = Number(data.slice('link:kind:'.length));
    const link = await getLink(env.DB, id);
    if (link) {
      const next = link.kind === 'main' ? 'extra' : link.kind === 'extra' ? 'broadcast' : 'main';
      await updateLink(env.DB, id, { kind: next });
    }
    return showLinkEdit(env, chatId, id, messageId);
  }

  // ------------------------------------------------------------- settings
  if (data === 'set:rate') {
    await setSession(env.DB, from.id, { state: 'set_rate', data: {} });
    return render(env, chatId, messageId, 'Введите скорость рассылки от 1 до 28 сообщений в секунду.\n\nРекомендуется 15–20.', {
      inline_keyboard: [backRow('menu:settings')],
    });
  }
  if (data === 'set:diag') {
    return runDiagnostics(env, chatId);
  }

  await showMainMenu(env, chatId, messageId);
}

async function sendWelcomeTest(env: Env, chatId: number): Promise<void> {
  const config = await getWelcomeConfig(env.DB);
  if (!config.enabled) {
    await notify(env, chatId, '⚠️ Приветствие выключено. Включите его, чтобы тест соответствовал реальной отправке.');
    return;
  }
  const linkMap = await getLinkMap(env.DB);
  const { content, buttons } = buildWelcomeContent(config, linkMap);
  const result = await sendContent(getMainToken(env), chatId, content, buttons, { retries: 1 });
  if (!result.result.ok) {
    await notify(
      env,
      chatId,
      `❌ Тест не отправлен: <code>${escapeHtml(result.result.description ?? 'unknown')}</code>`,
      { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu:welcome' }]] },
    );
    return;
  }
  await notify(env, chatId, '✅ Тестовое приветствие отправлено выше.', {
    inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'menu:welcome' }]],
  });
}

export async function handleAdminUpdate(
  update: TelegramUpdate,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  try {
    if (update.message) {
      await handleAdminMessage(env, update.message);
      return;
    }
    if (update.callback_query) {
      await handleAdminCallback(env, update.callback_query);
      return;
    }
    if (update.my_chat_member) {
      const status = update.my_chat_member.new_chat_member?.status;
      console.log(`ADMIN my_chat_member user=${update.my_chat_member.from.id} status=${status}`);
      return;
    }
    const type = Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';
    console.log(`ADMIN update ignored type=${type}`);
  } catch (err) {
    console.error(`ADMIN HANDLER FAIL update_id=${update.update_id}`, err);
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId) {
      await sendText(adminToken(env), chatId, '⚠️ Внутренняя ошибка. Попробуйте ещё раз или откройте /menu.');
    }
  }
}

// Re-exported for tests.
export { parseButtons, contentFromMessage, audienceKeyboard, contentForSend, dmLabel };
export type { ComposerData };
