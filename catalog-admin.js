// ЧБ-10: админ-команды каталогом из TG («скрой Mad Max», «цена FC 26 4990», «скидка GTA V 20»).
// Правки пишутся ТОЛЬКО в черновик магазина (POST /db/draft) — публикация остаётся вручную из админки.
// Разбор команды — через LLM (llm.js), по образцу crm.parseSale.

import { chat } from './llm.js';
import { extractJson } from './crm.js';

const STORE_API = (process.env.STORE_API_URL || 'https://api.poigraem.shop').replace(/\/+$/, '');

const ACTIONS = new Set(['hide', 'show', 'set_price', 'set_discount', 'clear_discount']);

const PARSE_PROMPT = `Ты — парсер команд владельца магазина игр по управлению каталогом. Владелец пишет короткую команду. Верни СТРОГО один JSON-объект без пояснений:
{
  "action": "hide" | "show" | "set_price" | "set_discount" | "clear_discount",
  "game": string,          // название игры из команды, без служебных слов («игру», «цену», предлогов)
  "value": number | null   // set_price — новая цена в рублях; set_discount — процент скидки; иначе null
}
Примеры:
«скрой Mad Max» → {"action":"hide","game":"Mad Max","value":null}
«покажи Mad Max» или «верни Mad Max» → {"action":"show","game":"Mad Max","value":null}
«цена FC 26 4990» или «подними цену FC 26 до 4990» → {"action":"set_price","game":"FC 26","value":4990}
«скидка на GTA V 20%» → {"action":"set_discount","game":"GTA V","value":20}
«убери скидку с GTA V» → {"action":"clear_discount","game":"GTA V","value":null}
Если команда не про каталог игр или непонятна — верни {"action":null,"game":null,"value":null}. Ничего не выдумывай.`;

// Разбирает команду владельца. Бросает Error с человекочитаемым текстом.
export async function parseCommand(text) {
  const res = await chat([
    { role: 'system', content: PARSE_PROMPT },
    { role: 'user', content: text },
  ]);
  const p = extractJson(res.content);
  if (!p || !ACTIONS.has(p.action) || typeof p.game !== 'string' || !p.game.trim()) {
    throw new Error('Не понял команду. Примеры: «скрой Mad Max», «цена FC 26 4990», «скидка GTA V 20%», «убери скидку с GTA V».');
  }
  p.game = p.game.trim().slice(0, 100);
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
  const r = await fetch(`${STORE_API}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': process.env.ADMIN_TOKEN || '', ...(opts.headers || {}) },
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
export async function applyOp({ action, gameId, value }) {
  const data = await loadDraftData();
  const game = (data.games || []).find(g => String(g.id) === String(gameId));
  if (!game) throw new Error('Игра не нашлась в черновике — каталог изменился, повтори команду.');
  if (action === 'hide') game.hidden = true;
  else if (action === 'show') game.hidden = false;
  else if (action === 'set_price') { game.priceRUB = value; game._manualPrice = true; } // замок от пересканирования цен
  else if (action === 'set_discount') game.discount = value;
  else if (action === 'clear_discount') game.discount = null;
  else throw new Error(`Неизвестное действие: ${action}`);
  await storeFetch('/db/draft', { method: 'POST', body: JSON.stringify(data) });
  return game;
}
