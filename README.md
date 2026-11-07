# autopriniyatie-bot

Telegram-бот на Cloudflare Workers: автоматически принимает заявки в закрытый канал, отправляет приветствие после одобрения и предоставляет отдельную админ-панель для рассылок.

## Возможности

- Автоматическое одобрение заявок на вступление в канал `CHANNEL_ID`.
- Приветственное сообщение после одобрения:
  - отправка через `user_chat_id` из заявки;
  - резервная отправка в известный приватный чат;
  - защита от повторной отправки по `dedupe_key`;
  - обработка блокировки бота и недоступного чата.
- Основной бот: `/start`, `/stop`, `/links`, `/help`, `/id`, согласие на рассылки.
- Отдельный админ-бот (другой токен, отдельный webhook):
  - 📊 Статистика
  - 📢 Создать рассылку
  - 📋 Управление рассылками
  - 🔗 Ссылки на каналы
  - 💬 Приветственное сообщение
  - 👥 Пользователи
  - ⚙️ Настройки
- Рассылки: текст, фото, видео, подпись, HTML/MarkdownV2, несколько inline-кнопок со ссылками.
- Сегменты аудитории, предпросмотр, подтверждение, пауза/возобновление/остановка, прогресс.
- Асинхронная доставка через Cloudflare Queues, DLQ и cron-восстановление.
- Хранение состояния в D1, существующий KV `BOT_KV` сохранён.
- Диагностика через `/health` и `/diagnose`.

## Архитектура

Один Worker с несколькими маршрутами:

| Маршрут | Назначение |
| --- | --- |
| `POST /webhook` | webhook основного бота |
| `POST /admin/webhook` | webhook админ-бота |
| `GET /health`, `GET /` | проверка сервиса без раскрытия токенов |
| `GET /diagnose` | расширенная диагностика, требуется `X-Diag-Key` |

Обработчики:

- `src/index.ts` — маршрутизация, webhook-и, queue и scheduled.
- `src/main-bot.ts` — заявки, `/start`, согласие, `my_chat_member`.
- `src/admin-bot.ts` — FSM админ-бота, меню, конструктор рассылок, ссылки, приветствие.
- `src/broadcast.ts` — очередь, движок рассылки, cron-восстановление.
- `src/welcome.ts` — приветствие и классификация ошибок доставки.
- `src/db.ts` — доступ к D1, аудитории, счётчики.
- `src/telegram.ts` — Telegram Bot API, повторы, клавиатуры.
- `src/env.ts` — токены, список админов, проверка webhook-секрета.
- `src/defaults.ts` — тексты по умолчанию.
- `src/types.ts` — типы и метки сегментов.

Потоки:

1. Telegram присылает `chat_join_request` на `/webhook`.
2. Worker записывает пользователя в D1 и одобряет заявку.
3. В очередь `autopriniyatie-broadcasts` ставится задача `welcome`.
4. Consumer отправляет приветствие и обновляет `dm_status`.
5. Админ создаёт рассылку в админ-боте; задачи `broadcast` обрабатывают получателей пакетами.
6. Cron раз в минуту чистит зависшие задачи, восстанавливает прерванные рассылки и старые админ-сессии.

## Требования

- Node.js 20+.
- Cloudflare account с доступом к Workers, D1, Queues.
- Wrangler 4.x.
- Два бота в Telegram: основной и админский.

## Переменные и секреты

Секреты не хранятся в репозитории. Для бота нужны:

| Имя | Обязательно | Описание |
| --- | --- | --- |
| `MAIN_BOT_TOKEN` | да | токен основного бота |
| `ADMIN_BOT_TOKEN` | да | токен админ-бота |
| `ADMIN_IDS` | да | Telegram ID админов через запятую |
| `CHANNEL_ID` | да | ID канала, например `-100...` |
| `WEBHOOK_SECRET` | рекомендуется | `secret_token` для `/webhook` |
| `ADMIN_WEBHOOK_SECRET` | рекомендуется | `secret_token` для `/admin/webhook` |
| `DIAG_KEY` | опционально | ключ для `/diagnose` |
| `BOT_TOKEN` | legacy | старый токен основного бота, если `MAIN_BOT_TOKEN` не задан |
| `ADMIN_ID` | legacy | один админ, если `ADMIN_IDS` не задан |

Если webhook-секрет не задан, webhook принимает запросы без проверки заголовка `X-Telegram-Bot-Api-Secret-Token`. Для production задавайте оба секрета.

## Локальная разработка

```bash
npm install
```

Создайте `.dev.vars` (не коммитится):

```dotenv
MAIN_BOT_TOKEN=123:main
ADMIN_BOT_TOKEN=456:admin
ADMIN_IDS=8406606797
CHANNEL_ID=-1004416682870
WEBHOOK_SECRET=dev-main-secret
ADMIN_WEBHOOK_SECRET=dev-admin-secret
DIAG_KEY=dev-diag-key
```

Примените миграции локально и запустите dev-сервер:

```bash
npm run db:migrate:local
npm run dev
```

Полезные команды:

```bash
npm run typecheck
npm test
npm run types
```

## Тесты

```bash
npm test
```

Тесты используют Vitest с Workers pool, локальный D1 и фейковые токены `8606393164:TEST` / `9000398776:TEST`. Реальные запросы в Telegram не отправляются: исходящий `fetch` подменяется в `test/telegram-mock.ts`.

Покрыто 33 теста:

- HTTP-слой, проверка секретов, health;
- регистрация через `/start`, одобрение заявки;
- доставка приветствия, дедупликация, блокировка;
- сегменты аудитории;
- текст/фото/видео рассылки, кнопки;
- pause/resume/stop;
- CRUD ссылок;
- сквозной сценарий создания рассылки в админ-боте.

## Миграции D1

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Схема находится в `migrations/0001_init.sql`:

- `users` — пользователи, статус личных сообщений, согласие;
- `messages` — журнал отправок и `dedupe_key`;
- `broadcasts` — рассылки и счётчики;
- `broadcast_recipients` — получатели и статусы;
- `channel_links` — динамические ссылки;
- `settings` — приветствие и скорость рассылки;
- `admin_sessions` — состояние диалогов админ-бота.

## Развёртывание

Выполняйте только после подтверждения. Перед деплоем проверьте `wrangler.toml` и миграции.

1. Применить миграции к production D1:

```bash
npx wrangler d1 migrations apply autopriniyatie-bot-db --remote
```

2. Задать секреты:

```bash
npx wrangler secret put MAIN_BOT_TOKEN
npx wrangler secret put ADMIN_BOT_TOKEN
npx wrangler secret put ADMIN_IDS
npx wrangler secret put CHANNEL_ID
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_WEBHOOK_SECRET
npx wrangler secret put DIAG_KEY
```

3. Задеплоить Worker:

```bash
npm run deploy
```

4. Установить webhook-и. Значения токенов и секретов подставляйте из хранилища, не коммитьте их.

```bash
curl "https://api.telegram.org/bot$MAIN_BOT_TOKEN/setWebhook" \
  -d "url=https://autopriniyatie-bot.zenaahont8.workers.dev/webhook" \
  -d "secret_token=$WEBHOOK_SECRET" \
  -d 'allowed_updates=["chat_join_request","message","callback_query","my_chat_member"]'

curl "https://api.telegram.org/bot$ADMIN_BOT_TOKEN/setWebhook" \
  -d "url=https://autopriniyatie-bot.zenaahont8.workers.dev/admin/webhook" \
  -d "secret_token=$ADMIN_WEBHOOK_SECRET" \
  -d 'allowed_updates=["message","callback_query"]'
```

5. Проверить:

```bash
curl https://autopriniyatie-bot.zenaahont8.workers.dev/health
curl -H "X-Diag-Key: $DIAG_KEY" https://autopriniyatie-bot.zenaahont8.workers.dev/diagnose
```

Важно: webhook-и основного и админского ботов указывают на разные маршруты. Повторный `setWebhook` одного бота не перезаписывает webhook другого.

## Админ-бот

Доступ только для ID из `ADMIN_IDS`. Меню:

- **Статистика** — пользователи, согласия, рассылки.
- **Создать рассылку** — тип контента, текст/подпись, формат, кнопки, аудитория, предпросмотр, подтверждение.
- **Управление рассылками** — список, детали, пауза, возобновление, остановка.
- **Ссылки на каналы** — CRUD, slug, URL, активность. Ссылки используются в кнопках и плейсхолдерах `{link:slug}`.
- **Приветственное сообщение** — текст/фото/видео, подпись, формат, кнопки, тест, сброс.
- **Пользователи** — последние пользователи и поиск по ID/username.
- **Настройки** — скорость рассылки, диагностика Telegram.

### Сегменты аудитории

| Сегмент | Кто получает |
| --- | --- |
| `all_allowed` | все, кому можно писать (`can_receive_messages = 1`) |
| `started` | запускавшие бота |
| `approved` | одобренные заявки |
| `consented` | явно согласившиеся на рассылки |
| `test` | только администраторы |

Для сегментов, где есть пользователи без согласия, показывается предупреждение и требуется дополнительное подтверждение. Для `consented` и `test` предупреждение не выводится.

## Семантика рассылки

- Доставка **at-least-once**. `messages.dedupe_key` и атомарный захват получателя защищают от повторов, но сбой между успешным ответом Telegram и записью в D1 может привести к повторной отправке.
- Успешный ответ Telegram API означает только то, что сообщение принято API. Это **не** подтверждение прочтения.
- `429` — повтор с `retry_after`.
- Временные сетевые ошибки — повтор через 5 секунд.
- После исчерпания попыток сообщение уходит в DLQ.
- `403`/блокировка и `400 chat not found` помечаются как `blocked`/`unreachable`, пользователь исключается из будущих рассылок.
- Cron раз в минуту:
  - возвращает зависшие `sending` в `pending`;
  - перезапускает прерванные `running` рассылки;
  - удаляет старые админ-сессии.

## Откат

Перед модернизацией создан бэкап:

- git tag `pre-modernization-backup`;
- bundle `C:\Users\User\work\backups\autopriniyatie-bot-pre-modernization.bundle`.

Для отката кода:

```bash
git checkout pre-modernization-backup
npm run deploy
```

D1 и очередь при этом не удаляются. Удаление D1/очереди выполняйте только вручную и после отдельного подтверждения.
