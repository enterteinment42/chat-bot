# Sessions Archive — chatbot

Старые записи лога сессий (перенесены из CLAUDE.md).

---

### 2026-06-05 (сессия 16)

**Что сделано:**
- `js/chatbot.js` — баг дублирующегося приветствия: флаг `_chatWelcomed`; тултип «Помогу с выбором 🎮» (через 4 сек, 10 сек видим); быстрые кнопки-подсказки в пустом чате; пульсирующий badge на иконке (гаснет при открытии); история в `localStorage` + `_saveHistory()/_loadHistory()`; функция `resetChat()` (кнопка ↺ в шапке); проверка `_chat_disabled` + `BroadcastChannel('chat-widget')` для вкл/выкл из админки
- `js/chatbot.js` — карточка рекомендаций переработана: цена + скидка под названием; кнопка «↗ Витрина» скроллит к `#gr-{gameId}` и мигает `chat-highlight` 2 сек; кнопка «💬 Написать менеджеру» в отдельной полосе под инпутом
- `styles.css` — стили: badge-анимация, тултип со стрелкой, `.chat-rec-bottom`, `.chat-highlight`, `.chat-manager-bar`, `.chat-new-btn`, мобильный `bottom:80px`
- `index.html` — тултип, кнопка ↺, полоса менеджера, обновлён аккордеон «💬 Чат-бот»: вкл/выкл виджет, два провайдера (Anthropic/OR), кнопка логов
- `js/admin-core.js` — `toggleChatWidget()`, `_updateWidgetToggleBtn()`, `downloadChatLogs()`; модели обновлены: Anthropic Direct (Sonnet 4.6, Haiku 4.5), OpenRouter (Gemini Flash 3.5 `~google/gemini-flash-latest`, Gemini Pro 3.1 `google/gemini-3.1-pro-preview`, ChatGPT 5.4 `~openai/gpt-latest`, ChatGPT Mini 5.4 `openai/gpt-5.4-mini`); читаемые лейблы в дропдауне
- `Standalone/chat-bot/server.js` — новый endpoint `GET /admin/logs` (последние 500 диалогов из `chat_conversations`, требует `X-Admin-Token`); задеплоен на VPS

**Что решили:**
- Алиасы моделей OpenRouter: брать из editorial bot (`~/poigraem-chatbot/../corespondbot/editorial-bot.js`), не угадывать по сайту
- Вкл/выкл виджета через `localStorage._chat_disabled` — без VPS, мгновенно; BroadcastChannel синхронизирует открытые вкладки
- История в localStorage (не sessionStorage) — диалог выживает между визитами; ↺ сбрасывает полностью

**Новые баги:** не обнаружено.

**Открытые вопросы:**
- Всё задеплоено, но визуально не проверено — нужно открыть сайт и проверить админку + виджет

**Что осталось:**
- Этап 5: red-teaming по чек-листу
- `channel: 'telegram'` в tg-bot.js (отложено)

---

### 2026-06-05 (сессия 15)

**Что сделано:**
- `Standalone/chat-bot/server.js` — добавлен CORS middleware: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Content-Type`, обработка preflight OPTIONS. Задеплоен на VPS через curl + pm2 restart.
- `js/chatbot.js` — добавлена функция `_fmtBot()`: экранирует HTML-символы, конвертирует `**text**` → `<b>text</b>`; пузырь бота теперь использует `innerHTML` вместо `textContent`.

**Что решили:**
- CORS отсутствовал полностью — браузер блокировал запросы с `poigraem.shop` к `api.poigraem.shop`. Это была причина «Что-то пошло не так» при каждом сообщении.
- Markdown-форматирование разделено по каналам: TG — `formatForTg()` в `tg-bot.js`, виджет — `_fmtBot()` в `chatbot.js`. Правки независимы, TG не затронут.

**Новые баги:** не обнаружено.

**Открытые вопросы:** нет.

**Что осталось:**
- `channel: 'telegram'` в tg-bot.js
- Настройки бота в панели администратора
- Этап 5: red-teaming по чек-листу

---

### 2026-06-05 (сессия 14)

**Что сделано:**
- `js/chatbot.js` (новый файл) — чат-виджет для магазина: плавающая кнопка `💬` fixed right-bottom, окно 320×460px, пузыри сообщений, sessionId в `sessionStorage`, история в памяти, POST `https://api.poigraem.shop/chatbot/api/chat` с `channel:'store'`, рекомендации с кнопкой «В корзину» (`toggleCartGame`), escalate → ссылка «🔍 Узнать цену», индикатор «...» пока ждёт ответа
- `index.html` — добавлен `<script src="js/chatbot.js"></script>` после `client.js`; HTML виджета перед `</body>`
- `styles.css` — стили виджета в конце файла, адаптив `@media(max-width:600px)`
- Коммит `be860e6`, запушен в `main` (rebase с 10 коммитами с remote)

**Что решили:**
- Виджет скрыт в admin-view через `MutationObserver` на `classList` — без правки `auth.js`
- `channel: 'store'` зафиксирован в запросе — флаг для будущего разделения промтов TG vs магазин (пока промты одинаковые)
- sessionId в `sessionStorage` (не localStorage) — сессия живёт до закрытия вкладки, не между визитами
- Настройки бота в админке — отдельная задача следующей сессии

**Новые баги:** не обнаружено.

**Открытые вопросы:**
- Виджет задеплоен, но визуально не проверен — нужно открыть poigraem.shop и убедиться что кнопка появляется

**Что осталось:**
- Проверить виджет на сайте
- `channel: 'telegram'` в tg-bot.js
- Настройки бота в панели администратора
- Этап 5: red-teaming по чек-листу

---

### 2026-06-04 (сессия 13)

**Что сделано:**
- `prompt-source/02-recommendation-rules.md` — добавлены три раздела: **ЦЕНЫ ПОДПИСОК И УМНЫЙ АПСЕЙЛ** (называть цены при апсейле, умный апсейл по сумме игры vs 3 мес. подписки, исключение EA Play — год, запрет повторного предложения после отказа); **КОЛИЧЕСТВО РЕКОМЕНДАЦИЙ** (строго 2-3, до 5 при явном запросе жанра); **ПЛАТФОРМЫ ВНЕ КАТАЛОГА** (клиент на PS5 — только PS VR2/PS5/PS4, не предлагать PC VR).
- `prompt-source/01-persona.md` — добавлен раздел **Чего ты не делаешь**: запрет слова «каталог» (замена: «на витрине», «можно достать»); запрет «к сожалению»; запрет лести; поддержка геймерских мемов (git gud, skill issue и др.) — подхватывать коротко, не объяснять.
- `prompt-source/07-goal-channel.md` — добавлено правило: ссылку на Telegram-канал предлагать только при явном завершении разговора без покупки, не в середине диалога.
- `prompt.js` — `buildCatalogBlocks()` дополнен: формирует `pricesBlock` из `catalog.subscriptionPrices` (формат `Название: план = цена₽, ...`); возвращает в объекте; подставляется в промт после `subsBlock`.
- Все файлы задеплоены на VPS, `poigraem-chatbot` и `poigraem-chatbot-tg` перезапущены.

**Что решили:**
- `pricesBlock` крепится к `subsBlock` (один `replace` в промте) — цены подписок идут сразу после списка игр подписок, логично для LLM.
- Деплой .md-файлов промта через `wget -qO` с переменной `$B` — единственный надёжный способ при переносах строк в терминале.

**Новые баги:** не обнаружено.

**Открытые вопросы:**
- Промт с ценами подписок визуально не протестирован — стоит проверить апсейл в реальном диалоге.

**Что осталось:**
- `channel: 'telegram'` не передаётся из tg-bot.js
- Этап 4: фронт-виджет в магазине
- Этап 5: red-teaming по чек-листу

---

### 2026-06-04 (сессия 12)

**Что сделано:**
- `catalog.js` — в `loadCatalog()` добавлен `subscriptionPrices`: читается из уже загруженного `snap.subs`, фильтрует активные (`s.active`), маппит `{ id, name, plans }`. Возвращается в кешируемом объекте рядом с `games` и `subscriptions`. Лог обновлён: показывает количество подписок с ценами.

**Что решили:**
- Дополнительный запрос к Supabase не нужен — цены подписок уже есть в снапшоте магазина (`snap.subs`), логично брать оттуда.

**Новые баги:** не обнаружено.

**Открытые вопросы:**
- `subscriptionPrices` загружен, но ещё не передаётся в `prompt.js` — следующий шаг: использовать в `buildSystemPrompt` чтобы бот знал актуальные цены подписок.

**Что осталось:**
- Использовать `catalog.subscriptionPrices` в `prompt.js`
- `channel: 'telegram'` не передаётся из tg-bot.js
- Этап 4: фронт-виджет в магазине
- Этап 5: red-teaming по чек-листу

### 2026-06-04 (сессия 11)

**Что сделано:**
- `server.js` — **Issue 1: фикс парсинга JSON.** Bracket-matching вместо greedy-regex: корректно обрабатывает вложенные `{}` и текст после закрывающей скобки (главная причина падений на длинных ответах). Умный fallback: при невалидном JSON извлекает поле `reply` регексом вместо дампа сырого контента.
- `server.js` — **Issue 2: escalate механика.** `priceLookupAvailable: true` в `buildSystemPrompt`. Поле `escalate` извлекается из ответа LLM и возвращается клиенту.
- `server.js` — Валидация `gameId`: сверяет gameId из ответа LLM против реального каталога; если не найден → `inCatalog: false`. Защита от галлюцинации (пример: LLM придумал UFC 4 в каталоге с ценой 1070₽).
- `tg-bot.js` — При `escalate.target === 'price_lookup'` добавляет inline-кнопку «🔍 Узнать цену» с URL `https://api.poigraem.shop/price-lookup/`.
- `prompt-source/05-response-format.md` — Добавлено поле `escalate` в схему JSON.
- `prompt-source/02-recommendation-rules.md` — Инструкция использовать escalate для не-каталожных игр + СТРОГО-запрет выдуманных цен.
- `prompt.js` — `{{PRICE_LOOKUP}}` → пустая строка (доступен) или резервная инструкция к менеджеру.

**Что решили:**
- Bracket-matching надёжнее greedy-regex: не ломается от текста после `}` и строк с `{}` внутри.
- escalate-механика: LLM ставит сигнал в JSON, tg-bot рендерит кнопку — URL не вшивается в текст.
- Price-lookup URL: `https://api.poigraem.shop/price-lookup/` (не poigraem.shop).
- Серверная валидация gameId надёжнее чем промт: LLM-галлюцинацию не искоренить инструкцией.
- LLM не всегда ставит escalate в ответе — промт усилен, но не 100%; текст `reply` может содержать выдуманные цены (сервер не может исправить текст, только JSON-поля).

**Новые баги:**
- LLM галлюцинирует цены в поле `reply` (текст сообщения клиенту) — сервер исправляет только `gameId`/`inCatalog`, но текст "UFC 4 сейчас в каталоге — 1070₽" остаётся. Требует отдельного исследования.

**Открытые вопросы:**
- Верификация: кнопка «🔍 Узнать цену» в TG-боте — Denis ещё не подтвердил что ведёт на правильный URL после финального деплоя.

**Что осталось:**
- `channel: 'telegram'` не передаётся из tg-bot.js
- Этап 4: фронт-виджет в магазине
- Этап 5: red-teaming по чек-листу
- Галлюцинация текста reply — исследовать, возможно нужна другая модель

### 2026-06-04 (сессия 10)

**Что сделано:**
- `prompt-source/01-persona.md` — добавлен запрет фраз «Отличный выбор!», «Прекрасный выбор!», «Хороший выбор!».
- `prompt-source/02-recommendation-rules.md` — добавлено правило апсейла подписки: если клиент хочет 2+ игры из одной подписки — СНАЧАЛА предложить подписку, с примером (GTA 5 + Hogwarts + RDR2 → PS Plus Extra). Добавлен явный запрет считать итоговую сумму («итого X рублей — не твоя работа, делает менеджер»).

**Что решили:**
- Рестарт `poigraem-chatbot-tg` для правок промта не нужен — промт читает только `poigraem-chatbot`.

**Новые баги:** не обнаружено.

**Открытые вопросы:** нет новых.

**Что осталось:**
- Усилить запрет JSON-обёртки в `05-response-format.md`
- Передать `channel: 'telegram'` из tg-bot.js
- Этап 4: фронт-виджет
- Этап 5: red-teaming

### 2026-06-04 (сессия 9)

**Что сделано:**
- `catalog.js` — параллельная загрузка `subscription_hierarchy` + `subscription_games` через `Promise.all`. Игры группируются по `subscription_key` и прикрепляются к каждой подписке. Возвращает `{ games, subscriptions, loadedAt }`. Лог: `Catalog: X игр, Y подписок`.
- `prompt.js` — `buildCatalogBlocks()` заполняет `{{CATALOG_SUBSCRIPTIONS}}` в формате `=== SUBSCRIPTION ===\nkey: ...\ntitle: ...\ngames: ...` (один блок на подписку, все игры перечислены).
- `prompt-source/06-catalog.md` — добавлен заголовок `## ПОДПИСКИ` (файл на VPS не обновился из-за ошибки curl, старая версия работает — плейсхолдер на месте).
- `server.js` — усилен парсер JSON: если LLM добавил текст перед `{`, вырезаем объект регексом `/\{[\s\S]*\}/`. Покрывает случай когда модель отвечает текстом + JSON вместо только JSON.
- Удалены чужие файлы из `prompt-source/`: `04-offtop-protection.md` и `06-catalog-section.md` (созданы Денисом в отдельном окне, раздували промт до ~30KB).
- Диагностика доступа к Supabase: anon key не мог читать subscription_* таблицы → Денис открыл доступ в Supabase → заработало.

**Что решили:**
- Формат подписок в промте: структурированные блоки `=== SUBSCRIPTION ===` — LLM лучше распознаёт границы секций.
- Причина JSON в речи: LLM выдаёт текст + JSON вместо только JSON. Парсер теперь вырезает объект. Дополнительно нужно усилить запрет в `05-response-format.md`.
- Файлы из разных окон Claude в одной папке конфликтуют — нужно договариваться о именовании.

**Новые баги:**
- JSON в речи — частично закрыт (парсер), но промт ещё не усилен. Нужно добавить в `05-response-format.md` жёсткий запрет выше по тексту.

**Открытые вопросы:**
- `channel: 'telegram'` не передаётся из `tg-bot.js` в `/api/chat` → бот игнорирует секцию 07-goal-channel.md для TG-канала.
- `06-catalog.md` на VPS — старая версия без `## ПОДПИСКИ` (65 байт). Работает, но неточная.

**Что осталось:**
- Усилить запрет JSON-обёртки в `05-response-format.md`
- Передать `channel: 'telegram'` из tg-bot.js
- Этап 4: фронт-виджет в магазине
- Этап 5: red-teaming

### 2026-06-04 (сессия 8)

**Что сделано:**
- `prompt-source/` — создана папка с 7 секциями промта: `01-persona.md`, `02-recommendation-rules.md`, `03-faq.md`, `04-offtop.md`, `05-response-format.md`, `06-catalog.md`, `07-goal-channel.md`.
- `prompt.js` — полностью переписан: читает `.md` файлы через `fs.readFileSync`, собирает в порядке `01→07`, заменяет плейсхолдеры `{{CATALOG_GAMES}}`, `{{CATALOG_SUBSCRIPTIONS}}`, `{{CHANNEL}}`, `{{PRICE_LOOKUP}}`. Шаблон кешируется при первом вызове. `buildCatalogBlocks()` сохраняет логику старого `buildCatalogBlock()`.
- Правки промта по ТЗ Дениса: персона не называет себя AI сам по себе; нет упоминания PS4/PS5 в приветствии; цена не называется без запроса; не считать корзину; не повторять отвергнутые игры; запрет `##` и списков в `reply`; `igdbRating` только если точно знает; более жёсткий запрет markdown-обёртки JSON; `@Small_Ben` в 03-faq.md; 07-goal-channel.md с логикой store vs telegram.
- `llm.js` — таймаут 30 000 мс на все три провайдера: OpenRouter, Gemini, Anthropic (второй аргумент `{ timeout: LLM_TIMEOUT_MS }`).
- `server.js` — улучшен catch-блок: лог с timestamp, userId (из X-Forwarded-For или sessionId), тип ошибки (timeout/другое). Fallback-сообщение клиенту: «Что-то пошло не так, напиши ещё раз — отвечу».

**Что решили:**
- Промт в файлах удобнее редактировать без правки кода — Денис может менять `.md` напрямую и перезапускать сервер.
- `channel` передаётся в `buildSystemPrompt` через `options.channel`. По умолчанию `'store'`. TG-бот пока не передаёт `channel` явно — добавить при Этапе 4.
- Таймаут задаётся через второй аргумент SDK-методов, а не `AbortController` — чище и поддерживается всеми тремя SDK.

**Новые баги:** не обнаружено.

**Открытые вопросы:**
- `channel` в TG-боте не передаётся — бот работает с дефолтом `'store'`. Нужно добавить `channel: 'telegram'` в запрос от `tg-bot.js` к `/api/chat`.
- `{{CATALOG_SUBSCRIPTIONS}}` — пустая строка пока нет данных о подписках в catalog.

**Что осталось:**
- Передать `channel: 'telegram'` из tg-bot.js
- Этап 4: фронт-виджет в магазине
- Этап 5: red-teaming по чек-листу

---

### 2026-06-03 (сессия 7)

**Что сделано:**
- `server.js` — **Баг 1 (rate limit):** добавлен `keyGenerator` в `makeLimit` — читает `X-Forwarded-For` вместо `req.ip`. TG-бот передаёт `tg-{chatId}`, каждый пользователь теперь получает свой бакет.
- `server.js` — **Баг 2 (JSON в сообщении):** regex для поиска JSON-блока теперь ищет по всему ответу LLM, не только в начале строки.
- `tg-bot.js` — **Баг 3 (пустой reply):** guard — если `reply` пустой, отправляется fallback-сообщение и история откатывается.
- `tg-bot.js` — **Баг 4 (Markdown):** добавлена `formatForTg()`, `parse_mode: 'HTML'`.

**Что решили:**
- `formatForTg` — только в `tg-bot.js`. Сервер возвращает чистый текст. При деплое через curl — всегда `cd ~/poigraem-chatbot` перед командой.

---

### 2026-06-02 (сессия 6)

**Что сделано:**
- `llm.js` — добавлен третий провайдер **Google Gemini Direct**: клиент через OpenAI SDK с `baseURL: https://generativelanguage.googleapis.com/v1beta/openai/`, функция `callGemini()`, ветка в `chat()`. Экспортирован `clearSettingsCache()` для инвалидации кеша после сохранения настроек.
- `llm.js` — добавлен `GEMINI_API_KEY` в `.env.example` и на VPS.
- `server.js` — два новых эндпоинта: `GET /admin/settings` и `POST /admin/settings` (требуют `X-Admin-Token`). После сохранения вызывают `clearSettingsCache('chatbot')` — изменения применяются без рестарта.
- `index.html` — аккордеон «💬 Чат-бот» в боковой панели админки: дропдауны провайдера (openrouter/anthropic/gemini) и модели, кнопка «Сохранить», статус.
- `js/admin-core.js` — функции `CHATBOT_MODELS`, `updateChatbotModels()`, `loadChatbotSettings()`, `saveChatbotSettings()`.
- `tg-bot.js` — **TG-обёртка**: polling через `api.telegram.org` (не локальный tg-api — нет конфликта с webhook-ботами), история диалога в памяти, `/start` сбрасывает сессию, антиспам 2 сек, `X-Forwarded-For: tg-{chatId}` для раздельного rate-limit. Бот: @Poigraem_Game_Helper_bot.
- `prompt.js` — три правки качества: (1) не сдаваться раньше 3 попыток с разных сторон; (2) один ответ — одна мысль, не дублировать; (3) показывать только текущую цену и процент скидки, не вычислять цену до скидки.
- VPS: все файлы задеплоены, `poigraem-chatbot-tg` запущен как отдельный PM2-процесс (id 6).

**Что решили:**
- Gemini Direct — через OpenAI SDK с другим baseURL, дополнительных пакетов не нужно.
- TG-бот использует polling через обычный api.telegram.org — избегает конфликта `deleteWebhook` с локальным tg-api сервером который используют другие боты.
- Переключатель модели живёт в Supabase `settings` — меняется из админки без рестарта сервера.
- Ключ CHATBOT_TG_TOKEN хранится в `.env` отдельно от основного магазина.

**Новые баги:** не обнаружено.

**Открытые вопросы:**
- Качество диалога промта — правки сессии задеплоены, но полноценное тестирование не завершено.

**Что осталось:**
- Проверить промт на новых тестовых диалогах
- Этап 4: фронт-виджет в магазине
- Этап 5: red-teaming по чек-листу

### 2026-05-31 (сессия 5)

**Что сделано:**
- Деплой на VPS: скачаны файлы через curl, создан `.env`, `npm install` (104 пакета), PM2, nginx location `/chatbot/` → `127.0.0.1:3002`.
- Фикс: Node.js 20 требует явной передачи `ws` как WebSocket-транспорта в Supabase-клиент.
- Финальный тест: бот отвечает, `inCatalog: true`, цены правильные.

**Что решили:**
- GitHub raw CDN кешируется ~несколько минут — при срочных правках применять sed напрямую на VPS.
- curl с JSON-телом: писать в файл и передавать `-d @file`.

---

### 2026-05-31 (сессия 4)

**Что сделано:**
- `catalog.js` — загрузка каталога из Supabase `store_snapshot` (id='main'), кеш 1 час, graceful fallback. Фильтр `!g.hidden`, поля: id, title, priceRUB, discount, isNew, popular, featured, description.
- `prompt.js` — `buildCatalogBlock(catalog)`: формат `id|название|цена|скидка|флаги` одной строкой. Флаги 🆕🔥⭐.
- `server.js` — `loadCatalog()` кешируется, передаётся в `buildSystemPrompt`; подключён `logConversation()`.
- `logger.js` — логирование в `chat_conversations`: upsert по session_id, sha256-hash IP, fire-and-forget. Требует legacy service_role JWT.
- Таблица `chat_conversations` создана в Supabase с явным `GRANT ALL ON ... TO service_role`.

**Что решили:**
- Legacy service_role JWT (`eyJhbGci...`) обходит RLS, новый `sb_secret_*` — нет.
- Новый Supabase (с 30.05.2026): все таблицы требуют явных GRANT для каждой роли.

---

### 2026-05-31 (сессия 3)

**Что сделано:**
- Запущен `npm install` — 102 пакета, 0 уязвимостей
- Сервер запущен, `/health` ответил `{status: ok}`
- Обнаружены и исправлены две проблемы при тесте:
  - **Кодировка** — PowerShell отправлял кириллицу в latin1, бот получал иероглифы. Фикс: `ContentType: application/json; charset=utf-8`
  - **Markdown-обёртка** — модель оборачивала JSON в \`\`\`json...\`\`\`. Фикс в `server.js`: стриппинг markdown-фенсов перед `JSON.parse()`
- Финальный тест прошёл: бот ответил по-русски, правильный тон, вернул `recommendations[]` с `igdbRating`, `usage` с токенами
- `.env` — заполнен `MANAGER_PRIMARY_VALUE=@small_ben`, `MANAGER_FALLBACK_VALUE=https://vk.com/club239030973`

**Что решили:**
- Этап 1 полностью закрыт — walking skeleton рабочий
- Контакты менеджера: Telegram `@small_ben` (основной), ВКонтакте `vk.com/club239030973` (если нет TG)
- `inCatalog: false` у всех рекомендаций — это ожидаемо, каталог подключается в Этапе 2

---

### 2026-05-30 (сессия 2)

**Что сделано:**
- `llm.js` — полная абстракция над двумя провайдерами: `getSettings(feature)` читает provider/model из Supabase `settings` с кешем 60 сек и fallback на `.env`; `bootstrapSettings()`; `callOpenRouter()` через OpenAI SDK; `callAnthropic()` через Anthropic SDK с prompt caching; `chat()` с двусторонним fallback для Anthropic-моделей.
- `prompt.js` — `buildSystemPrompt(catalog, options)`: персона, политика регионов, логика рекомендаций, JSON-формат ответа.
- `server.js` — rate limits (5/мин + 20/день), валидация, trim истории, парсинг JSON с fallback.

**Что решили:**
- Rate limits и fallback — часть Этапа 1 (walking skeleton). Prompt caching только для Anthropic Direct. Маппинг: `anthropic/claude-haiku-4-5` ↔ `claude-haiku-4-5-20251001`.

---

### 2026-05-30 (сессия 1)

**Что сделано:**
- Созданы все файлы структуры проекта: `package.json` (ES modules, зависимости), `.gitignore`, `.env.example` (все переменные по CLAUDE.md и BRIEFING.md)
- Созданы заглушки: `server.js` (GET /health + POST /api/chat-stub), `llm.js`, `prompt.js`, `catalog.js`, `descriptions.js`, `tracking.js`, `logger.js`
- Файлы закоммичены и запушены в основной репо `enterteinment42/poigraem` (другое окно Claude Code включило их в коммит `21d6f05`)

**Что решили:**
- Отдельный git-репо для chatbot не нужен — папка `Standalone/chat-bot/` уже внутри основного репо poigraem. Создавать новый репо будем только при деплое на VPS (Этап 7).
- Вложенный `.git` (ошибочно созданный через `git init`) удалён.

**Новые баги:** не обнаружено.

**Открытые вопросы:** нет.

**Что осталось:**
- Этап 1: реализовать working POST /api/chat с OpenRouter и системным промтом (без каталога, без логов)
