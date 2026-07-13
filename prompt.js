// Системный промт собирается из файлов prompt-source/01-07.md
// Динамические блоки подставляются через плейсхолдеры.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = path.join(__dirname, 'prompt-source');

// Шаблон кешируется при первом вызове — перезагружается только при рестарте сервера
let _template = null;

function getTemplate() {
  if (!_template) {
    _template = fs.readdirSync(PROMPT_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
      .map(f => fs.readFileSync(path.join(PROMPT_DIR, f), 'utf8').trim())
      .join('\n\n');
  }
  return _template;
}

export function buildSystemPrompt(catalog = null, options = {}) {
  const { context, channel = 'store', priceLookupAvailable = false, knownSubs = [] } = options;

  const { gamesBlock, subsBlock, pricesBlock } = buildCatalogBlocks(catalog);

  let prompt = getTemplate()
    .replace('{{CATALOG_GAMES}}', gamesBlock)
    .replace('{{CATALOG_SUBSCRIPTIONS}}', subsBlock + pricesBlock)
    .replace('{{CHANNEL}}', channel)
    .replace('{{SETUP_PRICE}}', process.env.SETUP_PRICE || '200')
    .replace('{{PRICE_LOOKUP}}', priceLookupAvailable
      ? ''
      : 'Если price-lookup недоступен — вместо escalate направляй к менеджеру @Small_Ben.');

  // Контекстные блоки — добавляются в начало промта
  const ctxLines = [];

  // Сегодняшняя дата (нужна для расчёта дат окончания подписок)
  ctxLines.push(`Сегодня: ${new Date().toISOString().split('T')[0]}.`);

  // Известные подписки клиента (сохранены с прошлых сессий)
  if (knownSubs.length > 0) {
    ctxLines.push(`Клиент ранее сообщал о своих подписках: ${knownSubs.join(', ')}. Не переспрашивай о наличии этих подписок.`);
  }

  prompt = ctxLines.join('\n') + '\n\n' + prompt;

  // Контекст игры — добавляется в начало, только для первого сообщения в сессии
  if (context?.currentGameName) {
    const ctxBlock = `Контекст сессии: клиент пришёл со страницы игры "${context.currentGameName}". Начни: "Вижу ты смотришь ${context.currentGameName} — хочешь что-то похожее или вообще другое?"`;
    prompt = ctxBlock + '\n\n' + prompt;
  }

  return prompt;
}

function buildCatalogBlocks(catalog) {
  if (!catalog?.games?.length) {
    return {
      gamesBlock: 'Каталог сейчас недоступен. Рекомендуй по своим знаниям; для всех игр предложи узнать цену.',
      subsBlock: '',
      pricesBlock: '',
    };
  }

  // --- Игры на продажу ---
  const lines = catalog.games.map(g => {
    let line = `${g.id}|${g.title}|${g.priceRUB}₽`;
    if (g.discount) line += `|-${g.discount}%`;
    const flags = [];
    if (g.isNew) flags.push('🆕');
    if (g.popular) flags.push('🔥');
    if (g.featured) flags.push('⭐');
    if (flags.length) line += `|${flags.join('')}`;
    return line;
  });

  const gamesBlock = `Наш каталог (${catalog.games.length} игр, формат: id|название|цена|скидка|флаги):\n${lines.join('\n')}\n\nФлаги: 🆕=новинка, 🔥=популярное, ⭐=горячее предложение со скидкой.\nЕсли игра есть в этом списке — inCatalog: true, gameId = её id. Иначе inCatalog: false.`;

  // --- Подписки ---
  let subsBlock = '';
  if (catalog.subscriptions?.length) {
    const subBlocks = catalog.subscriptions.map(sub => {
      const key = sub.key || sub.subscription_key || sub.id;
      const title = sub.name || sub.title || key;
      const gamesList = sub.games?.map(g => g.title).join(', ') || '';
      return `=== SUBSCRIPTION ===\nkey: ${key}\ntitle: ${title}\ngames: ${gamesList}`;
    });
    subsBlock = subBlocks.join('\n\n') + '\n\nЕсли клиент спрашивает есть ли игра в подписке — проверяй по этому списку.';
  }

  let pricesBlock = '';
  if (catalog.subscriptionPrices?.length) {
    const lines = catalog.subscriptionPrices.map(s => {
      const plans = (s.plans || []).map(p => `${p.label} = ${p.price}₽`).join(', ');
      return `${s.name}: ${plans}`;
    });
    pricesBlock = `\n\n## ЦЕНЫ ПОДПИСОК (актуальные из магазина)\n${lines.join('\n')}`;
  }

  return { gamesBlock, subsBlock, pricesBlock };
}
