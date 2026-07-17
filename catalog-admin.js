// ЧБ-10: админ-команды каталогом из TG («скрой Mad Max», «цена FC 26 4990», «скидка GTA V 20»).
// Правки пишутся ТОЛЬКО в черновик магазина (POST /db/draft) — публикация остаётся вручную из админки.
// Разбор команды — через LLM (llm.js), по образцу crm.parseSale.

import { chat } from './llm.js';
import { extractJson } from './crm.js';

const STORE_API = (process.env.STORE_API_URL || 'https://api.poigraem.shop').replace(/\/+$/, '');

const ACTIONS = new Set(['hide', 'show', 'set_price', 'set_discount', 'clear_discount', 'set_flag', 'clear_flag', 'info']);

// Витринные флаги снапшота магазина (те же поля читает catalog.js для промта бота)
export const FLAG_LABELS = { featured: '⭐ витрина', isNew: '🆕 новинка', popular: '🔥 хит' };

const PARSE_PROMPT = `Ты — парсер команд владельца магазина игр по управлению каталогом. Владелец пишет короткую команду. Верни СТРОГО один JSON-объект без пояснений:
{
  "action": "hide" | "show" | "set_price" | "set_discount" | "clear_discount" | "set_flag" | "clear_flag" | "info",
  "game": string,          // название игры из команды, без служебных слов («игру», «цену», предлогов)
  "value": number | null,  // set_price — новая цена в рублях; set_discount — процент скидки; иначе null
  "flag": "featured" | "isNew" | "popular" | null  // только для set_flag/clear_flag: витрина=featured, новинка=isNew, хит/популярная=popular
}
Примеры:
«скрой Mad Max» → {"action":"hide","game":"Mad Max","value":null,"flag":null}
«покажи Mad Max» или «верни Mad Max» → {"action":"show","game":"Mad Max","value":null,"flag":null}
«цена FC 26 4990» или «подними цену FC 26 до 4990» → {"action":"set_price","game":"FC 26","value":4990,"flag":null}
«скидка на GTA V 20%» → {"action":"set_discount","game":"GTA V","value":20,"flag":null}
«убери скидку с GTA V» → {"action":"clear_discount","game":"GTA V","value":null,"flag":null}
«добавь на витрину GTA V» → {"action":"set_flag","game":"GTA V","value":null,"flag":"featured"}
«убери с витрины GTA V» → {"action":"clear_flag","game":"GTA V","value":null,"flag":"featured"}
«отметь новинкой FC 26» → {"action":"set_flag","game":"FC 26","value":null,"flag":"isNew"}
«сделай хитом Mad Max» или «отметь популярной Mad Max» → {"action":"set_flag","game":"Mad Max","value":null,"flag":"popular"}
«убери хит с Mad Max» → {"action":"clear_flag","game":"Mad Max","value":null,"flag":"popular"}
«инфо FC 26» или «покажи карточку FC 26» → {"action":"info","game":"FC 26","value":null,"flag":null}
Если команда не про каталог игр или непонятна — верни {"action":null,"game":null,"value":null,"flag":null}. Ничего не выдумывай.`;

// Разбирает команду владельца. Вернёт null, если LLM решил, что это не команда каталогу
// (тогда сообщение должно уйти обычным путём). Бросает Error с человекочитаемым текстом.
export async function parseCommand(text) {
  const res = await chat([
    { role: 'system', content: PARSE_PROMPT },
    { role: 'user', content: text },
  ]);
  const p = extractJson(res.content);
  if (p && p.action === null) return null;
  if (!p || !ACTIONS.has(p.action) || typeof p.game !== 'string' || !p.game.trim()) {
    throw new Error('Не понял команду. Примеры: «скрой Mad Max», «цена FC 26 4990», «скидка GTA V 20%», «добавь на витрину GTA V», «инфо FC 26».');
  }
  p.game = p.game.trim().slice(0, 100);
  if (p.action === 'set_flag' || p.action === 'clear_flag') {
    if (!Object.hasOwn(FLAG_LABELS, p.flag)) {
      throw new Error('Не понял, какой флаг: витрина, новинка или хит. Например: «добавь на витрину GTA V».');
    }
  } else {
    p.flag = null;
  }
  if (p.action === 'set_price') {
    p.value = Math.round(Number(p.value));
    if (!Number.isFinite(p.value) || p.value < 10 || p.value > 500000) {
      throw new Error(`Подозрительная цена: ${p.value}. Укажи явно, например: «цена FC 26 4990».`);
    }
  } else if (p.action === 'set_discount') {
    p.value = Math.round(Number(p.value));
    if (!Number.isFinite(p.value) || p.value < 1 || p.value > 95) {
      throw new Error(`Скидка должна быть от 1 до 95%. Например: «скидка GTA V 20%».`);
    }
  } else {
    p.value = null;
  }
  return p;
}

async function storeFetch(path, opts = {}) {
  // Бэкенд магазина (в отличие от эндпоинтов самого чат-бота) ждёт Authorization: Bearer, не X-Admin-Token
  const r = await fetch(`${STORE_API}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.ADMIN_TOKEN || ''}`, ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Магазин ответил ${r.status} на ${path}`);
  return r.json();
}

// Черновик магазина; если его ещё нет — основой берём опубликованный снапшот
export async function loadDraftData() {
  const draft = await storeFetch('/db/draft');
  if (draft?.data?.games?.length) return draft.data;
  const snap = await storeFetch('/db/snapshot');
  if (!snap?.data?.games?.length) throw new Error('Не удалось загрузить каталог магазина.');
  return snap.data;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

// Поиск игры по названию: точное совпадение, иначе подстрока. Ищет и среди скрытых.
export function findGames(games, query) {
  const q = norm(query);
  if (!q) return [];
  const exact = games.filter(g => norm(g.title) === q);
  if (exact.length) return exact;
  return games.filter(g => norm(g.title).includes(q)).slice(0, 6);
}

// Применяет подтверждённую операцию: свежий черновик → правка одного поля → запись целиком.
// Черновик всегда перечитывается прямо перед записью, чтобы не затереть параллельные правки.
export async function applyOp({ action, gameId, value, flag }) {
  const data = await loadDraftData();
  const game = (data.games || []).find(g => String(g.id) === String(gameId));
  if (!game) throw new Error('Игра не нашлась в черновике — каталог изменился, повтори команду.');
  if (action === 'set_flag' || action === 'clear_flag') {
    if (!Object.hasOwn(FLAG_LABELS, flag)) throw new Error(`Неизвестный флаг: ${flag}`);
    game[flag] = action === 'set_flag';
  }
  else if (action === 'hide') game.hidden = true;
  else if (action === 'show') game.hidden = false;
  else if (action === 'set_price') { game.priceRUB = value; game._manualPrice = true; } // замок от пересканирования цен
  else if (action === 'set_discount') game.discount = value;
  else if (action === 'clear_discount') game.discount = null;
  else throw new Error(`Неизвестное действие: ${action}`);
  await storeFetch('/db/draft', { method: 'POST', body: JSON.stringify(data) });
  return game;
}
