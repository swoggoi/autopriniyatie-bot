import type { WelcomeConfig } from './types';

export const DEFAULT_WELCOME: WelcomeConfig = {
  enabled: true,
  contentType: 'text',
  text:
    '<b>Добро пожаловать!</b>\n\n' +
    'Спасибо за вступление в наш канал!\n\n' +
    'Подписывайся также на наш дополнительный канал, чтобы не пропускать важные обновления.',
  caption: '',
  fileId: undefined,
  parseMode: 'HTML',
  buttons: [{ text: 'ПЕРЕЙТИ В КАНАЛ', link: 'main' }],
};

export const MAIN_MENU_TITLE =
  '<b>Панель управления ботом</b>\n\n' +
  'Выберите раздел. Все действия выполняются от имени администратора.';

export const CONSENT_TEXT =
  '<b>Вы подписались на бота.</b>\n\n' +
  'Хотите получать важные обновления и сообщения от администрации канала?\n\n' +
  'Согласие можно отозвать в любой момент командой /stop.';
