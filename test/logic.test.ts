import { describe, expect, it } from 'vitest';
import {
  buildInlineKeyboard,
  classifyTelegramError,
  escapeHtml,
  splitMessage,
  truncate,
} from '../src/telegram';
import { audienceWhere, resolveLinkPlaceholders, resolveStoredButtons } from '../src/db';
import { contentFromMessage, parseButtons } from '../src/admin-bot';
import { buildWelcomeContent } from '../src/welcome';
import type { ChannelLink, LinkMap } from '../src/db';
import type { TelegramMessage, WelcomeConfig } from '../src/types';

describe('telegram helpers', () => {
  it('splits long messages into <=3900 char chunks', () => {
    const text = Array.from({ length: 400 }, (_, i) => `Строка ${i} ${'x'.repeat(30)}`).join('\n');
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(3900);
    expect(chunks.join('\n').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  it('escapes HTML', () => {
    expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;&quot;');
  });

  it('truncates with ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
  });

  it('builds keyboards, filters invalid URLs and caps at 12', () => {
    const buttons = Array.from({ length: 15 }, (_, i) => ({ text: `b${i}`, url: `https://t.me/${i}` }));
    buttons.push({ text: 'bad', url: 'ftp://example.com' });
    const keyboard = buildInlineKeyboard(buttons);
    expect(keyboard?.inline_keyboard.length).toBe(6);
    expect(keyboard?.inline_keyboard[0].length).toBe(2);
    expect(JSON.stringify(keyboard)).not.toContain('ftp://');
  });

  it('classifies Telegram errors correctly', () => {
    expect(classifyTelegramError({ ok: false, status: 403, description: 'Forbidden: bot was blocked by the user' })).toBe('blocked');
    expect(classifyTelegramError({ ok: false, status: 400, description: 'Bad Request: chat not found' })).toBe('unreachable');
    expect(classifyTelegramError({ ok: false, status: 400, description: "Bad Request: bot can't initiate conversation with a user" })).toBe('unreachable');
    expect(classifyTelegramError({ ok: false, status: 429, description: 'Too Many Requests' })).toBe('retryable');
    expect(classifyTelegramError({ ok: false, status: 0, network: true })).toBe('retryable');
    expect(classifyTelegramError({ ok: false, status: 400, description: "Bad Request: can't parse entities" })).toBe('fatal');
  });
});

describe('audience segments', () => {
  it('uses separate, non-overlapping SQL predicates', () => {
    expect(audienceWhere('all_allowed', []).sql).toContain("dm_status = 'allowed'");
    expect(audienceWhere('started', []).sql).toContain('started_at IS NOT NULL');
    expect(audienceWhere('approved', []).sql).toContain('approved_at IS NOT NULL');
    expect(audienceWhere('consented', []).sql).toContain('consent_broadcasts = 1');
    expect(audienceWhere('test', [1, 2]).params).toEqual([1, 2]);
    expect(audienceWhere('test', []).sql).toBe('0 = 1');
  });
});

describe('dynamic links', () => {
  const map: LinkMap = {
    main: {
      id: 1,
      slug: 'main',
      title: 'Основной',
      url: 'https://t.me/main',
      kind: 'main',
      active: 1,
      sort_order: 1,
      created_at: '',
      updated_at: '',
    } satisfies ChannelLink,
  };

  it('resolves {link:slug} placeholders', () => {
    expect(resolveLinkPlaceholders('Перейти: {link:main}', map)).toBe('Перейти: https://t.me/main');
    expect(resolveLinkPlaceholders('Нет: {link:missing}', map)).toBe('Нет: ');
  });

  it('resolves stored button references at send time', () => {
    const buttons = resolveStoredButtons(
      [
        { text: 'Канал', link: 'main' },
        { text: 'Прямая', url: 'https://example.com' },
        { text: 'Нет ссылки', link: 'missing' },
      ],
      map,
    );
    expect(buttons).toEqual([
      { text: 'Канал', url: 'https://t.me/main' },
      { text: 'Прямая', url: 'https://example.com' },
    ]);
  });

  it('parses buttons JSON defensively', () => {
    expect(parseButtons('not json')).toEqual([]);
    expect(parseButtons('[{"text":"A","url":"https://a"}]')).toHaveLength(1);
    expect(parseButtons('[{"url":"https://a"}]')).toEqual([]);
  });
});

describe('content extraction', () => {
  const base: TelegramMessage = { message_id: 1, date: 1, chat: { id: 1, type: 'private' } };

  it('extracts text', () => {
    const result = contentFromMessage({ ...base, text: '<b>Hi</b>' }, 'text');
    expect(result.content?.contentType).toBe('text');
    expect(result.content?.text).toBe('<b>Hi</b>');
  });

  it('extracts the largest photo and caption', () => {
    const result = contentFromMessage(
      {
        ...base,
        photo: [
          { file_id: 'small' },
          { file_id: 'big' },
        ],
        caption: 'Подпись',
      },
      'photo',
    );
    expect(result.content?.fileId).toBe('big');
    expect(result.content?.caption).toBe('Подпись');
  });

  it('extracts video', () => {
    const result = contentFromMessage({ ...base, video: { file_id: 'video-1' } }, 'video');
    expect(result.content?.contentType).toBe('video');
    expect(result.content?.fileId).toBe('video-1');
  });

  it('rejects mismatched content', () => {
    expect(contentFromMessage({ ...base, text: 'hi' }, 'photo').error).toBeTruthy();
    expect(contentFromMessage({ ...base, photo: [{ file_id: 'x' }] }, 'text').error).toBeTruthy();
  });
});

describe('welcome content', () => {
  it('resolves placeholders and buttons from the welcome config', () => {
    const config: WelcomeConfig = {
      enabled: true,
      contentType: 'text',
      text: 'Привет {link:main}',
      caption: '',
      parseMode: 'HTML',
      buttons: [{ text: 'Канал', link: 'main' }],
    };
    const map: LinkMap = {
      main: {
        id: 1,
        slug: 'main',
        title: 'Main',
        url: 'https://t.me/main',
        kind: 'main',
        active: 1,
        sort_order: 1,
        created_at: '',
        updated_at: '',
      },
    };
    const built = buildWelcomeContent(config, map);
    expect(built.content.text).toBe('Привет https://t.me/main');
    expect(built.buttons).toEqual([{ text: 'Канал', url: 'https://t.me/main' }]);
  });
});
