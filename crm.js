// Мини-CRM: учёт проданных клиентам подписок и напоминания владельцу о продлении.
// Таблица client_subs в Supabase. Разбор свободного текста продажи — через LLM (llm.js).

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { chat } from './llm.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });

export const CHANNEL_LABELS = { avito: 'Авито', vk: 'ВК', tg: 'Telegram', other: 'другой канал' };

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function addMonths(baseISO, months) {
  const d = new Date(baseISO + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().split('T')[0];
}

export function fmtDate(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function daysLeft(iso) {
  return Math.round((new Date(iso + 'T12:00:00Z') - new Date(todayISO() + 'T12:00:00Z')) / 86400000);
}

// Телефон к единому виду +7XXXXXXXXXX. Не похоже на номер — вернём null, значение уйдёт как есть.
function normPhone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  if (!/^[\d\s+\-()]+$/.test(String(v || '').trim())) return null; // в строке есть буквы — это не телефон
  if (digits.length === 11) return '+' + (digits[0] === '8' ? '7' : digits[0]) + digits.slice(1);
  if (digits.length === 10) return '+7' + digits;
  return null;
}

// Вытаскивает JSON-объект из ответа LLM (модель может обернуть его в ```json ... ``` или прозу)
export function extractJson(content) {
  try { return JSON.parse(content); } catch {}
  const m = String(content).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

const PARSE_PROMPT = `Ты — парсер заметок о продажах игровых подписок. Владелец магазина пишет неформальную заметку о продаже или продлении подписки клиенту. Верни СТРОГО один JSON-объект без пояснений:
{
  "intent": "sale" | "renewal",        // "renewal" если написано «продлил», иначе "sale"
  "client_name": string,               // имя или ник клиента (без @)
  "channel": "avito" | "vk" | "tg" | "other",  // авито/вк/телега(телеграм, tg)
  "client_link": string | null,        // ссылка из текста (vk.com/..., t.me/...) целиком с https://; если канал tg и указан @ник — "https://t.me/ник"; иначе null
  "subs": string[],                    // ВСЕ подписки из заметки, каждая отдельным элементом, в общепринятом виде: "PS Plus Essential/Extra/Deluxe", "Game Pass Ultimate", "EA Play" и т.п.
  "months": number | null,             // срок в месяцах: «на год» = 12, «на 3 мес» = 3
  "start_date": "YYYY-MM-DD" | null,   // дата оформления/покупки, если названа в тексте
  "expires_date": "YYYY-MM-DD" | null, // только если явно названа дата ОКОНЧАНИЯ («до 18 января 2027»)
  "contact": string | null,            // как найти КЛИЕНТА: телефон («телефон +7 917 202 2380» → "+79172022380"), почта или ник для связи. Телефон — всегда в формате +7XXXXXXXXXX
  "seller_account": string | null,     // с какого аккаунта ПРОДАВЦА продано: «аккаунт Денис» / «с аккаунта Игры для консолей» → "Денис" / "Игры для консолей". Только название, без слова «аккаунт»
  "account_login": string | null,      // логин/почта от самого аккаунта подписки (PSN, Xbox и т.п.), если названы
  "note": string | null                // прочие детали, не попавшие в поля выше, иначе null
}
Сегодня {TODAY}.
ВАЖНО про даты: дату окончания НЕ вычисляй сам — её считает программа. Твоё дело — вернуть срок (months) и дату оформления (start_date), если она названа.
- «18 января оформил Ивану пс+ экстра на год» → months=12, start_date="{YEAR}-01-18", expires_date=null
- «продал Ивану пс+ экстра на год» → months=12, start_date=null, expires_date=null
- «оформил Ивану пс+ экстра до 18 января 2027» → months=null, start_date=null, expires_date="2027-01-18"
- Если в дате не назван год — бери ближайшую такую дату В ПРОШЛОМ, не в будущем.
ВАЖНО про несколько подписок: «оформил Ивану ПС+ экстра и ЕА плэй на год» → subs=["PS Plus Extra","EA Play"] (два элемента, НЕ склеивай в одну строку).
ВАЖНО про контакты: телефон клиента — это способ найти его в Telegram, он критичен, не теряй его. «продал Ивану пс+ экстра на год, телефон +7 904 231 90 75, аккаунт Денис» → contact="+79042319075", seller_account="Денис".
Чего нет в тексте — ставь null, не выдумывай.`;

// Разбирает текст владельца в структуру продажи. Бросает Error с человекочитаемым текстом.
export async function parseSale(text) {
  const today = todayISO();
  const res = await chat([
    { role: 'system', content: PARSE_PROMPT.replace('{TODAY}', today).replace('{YEAR}', today.slice(0, 4)) },
    { role: 'user', content: text },
  ]);
  const p = extractJson(res.content);
  // subs[] — новая схема, sub_name — старая: модель иногда отвечает по-старому, принимаем оба.
  // Плюс страховка на склейку «PS Plus Extra, EA Play» в одном элементе (ровно так она вела себя до правки).
  const subs = [...new Set(
    (Array.isArray(p?.subs) && p.subs.length ? p.subs : [p?.sub_name])
      .flatMap(s => String(s || '').split(/\s*,\s*|\s+и\s+/i))
      .map(s => s.trim().slice(0, 60))
      .filter(Boolean)
  )];
  if (!p || !p.client_name || !subs.length) {
    throw new Error('Не смог разобрать запись. Напиши в формате: «продал Ивану с авито PS Plus Extra на 12 мес»');
  }
  if (subs.length > 5) {
    throw new Error(`Насчитал ${subs.length} подписок в одной заметке — похоже на ошибку разбора. Запиши их отдельными сообщениями.`);
  }
  p.subs = subs;
  if (!p.months && !p.expires_date) {
    throw new Error(`Не понял срок подписки для «${p.client_name} — ${subs.join(', ')}». Укажи, на сколько месяцев или до какой даты.`);
  }
  // LLM-вывод идёт прямо в базу — не доверяем ему без границ (урок Б-4)
  if (!p.months) p.months = null; // 0/пусто = «не указан», срок возьмём из expires_date
  else {
    p.months = Math.round(Number(p.months));
    if (!Number.isFinite(p.months) || p.months < 1 || p.months > 36) {
      throw new Error(`Подозрительный срок: ${p.months} мес. Жду от 1 до 36 месяцев.`);
    }
  }
  if (p.expires_date != null) {
    const yearAgo = new Date(Date.now() - 366 * 86400000).toISOString().split('T')[0];
    const in4y = new Date(Date.now() + 4 * 366 * 86400000).toISOString().split('T')[0];
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(String(p.expires_date)) && !isNaN(Date.parse(p.expires_date + 'T12:00:00Z'));
    if (!valid || p.expires_date < yearAgo || p.expires_date > in4y) {
      throw new Error(`Подозрительная дата окончания: «${p.expires_date}». Назови её явно, например «до 15 января 2027».`);
    }
  }
  // Дата оформления: от неё код отсчитывает срок. Границы шире, чем у даты окончания
  // (продажу могли записать задним числом), но будущее дальше месяца — почти наверняка
  // модель приняла за начало дату окончания.
  if (p.start_date != null) {
    const twoYearsAgo = new Date(Date.now() - 2 * 366 * 86400000).toISOString().split('T')[0];
    const in1m = new Date(Date.now() + 31 * 86400000).toISOString().split('T')[0];
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(String(p.start_date)) && !isNaN(Date.parse(p.start_date + 'T12:00:00Z'));
    if (!valid || p.start_date < twoYearsAgo || p.start_date > in1m) {
      throw new Error(`Подозрительная дата оформления: «${p.start_date}». Назови её явно, например «18 января оформил …».`);
    }
  } else p.start_date = null;
  if (!['avito', 'vk', 'tg', 'other'].includes(p.channel)) p.channel = 'other';
  p.client_name = String(p.client_name).trim().slice(0, 80);
  if (p.client_name.startsWith('@')) p.client_name = p.client_name.slice(1);
  // Контакт клиента — часто единственный способ его найти (в Telegram у многих нет username),
  // поэтому телефон приводим к одному виду: иначе один номер выглядит как три разных.
  p.contact = normPhone(p.contact) || (p.contact ? String(p.contact).trim().slice(0, 80) : null);
  // Модель иногда возвращает «аккаунт Денис» вместо «Денис» — срезаем служебное слово
  // Заглавная буква обязательна: «игры для консолей» и «Игры для консолей» — один и тот же
  // аккаунт, но в базе легли бы двумя разными (миграция старых заметок писала с заглавной)
  p.seller_account = p.seller_account
    ? String(p.seller_account).replace(/^\s*(?:с\s+)?аккаунт[а-яё]*\s+/i, '').trim().replace(/^./, c => c.toUpperCase()).slice(0, 60) || null
    : null;
  p.account_login = p.account_login ? String(p.account_login).trim().slice(0, 120) : null;
  p.note = p.note ? String(p.note).trim().slice(0, 300) : null;
  return p;
}

// ===== Редактирование записей текстом («удали Ивана PS Plus», «измени дату Ивану на 5 сентября») =====

// Поля, которые владелец может править командой. Ключ — колонка, значение — как называем в карточке.
export const EDITABLE_FIELDS = {
  expires_at:     'дата окончания',
  contact:        'контакт клиента',
  seller_account: 'аккаунт продавца',
  account_login:  'логин подписки',
  client_name:    'имя клиента',
  client_link:    'ссылка на профиль',
  sub_name:       'название подписки',
  note:           'заметка',
};

const EDIT_PROMPT = `Ты — парсер команд редактирования CRM магазина подписок. Владелец правит запись о клиенте. Верни СТРОГО один JSON-объект без пояснений:
{
  "action": "delete" | "update",
  "client_name": string,        // имя клиента в ИМЕНИТЕЛЬНОМ падеже: «удали Ивана» → "Иван", «Владимиру» → "Владимир"
  "sub_name": string | null,    // подписка, если названа: "PS Plus Extra", "EA Play", "Game Pass Ultimate"
  "field": "expires_at" | "contact" | "seller_account" | "account_login" | "client_name" | "client_link" | "sub_name" | "note" | null,
  "value": string | null        // новое значение; дата — строго "YYYY-MM-DD"; телефон — "+7XXXXXXXXXX"; аккаунт продавца — без слова «аккаунт»
}
Сегодня {TODAY}. Если год в дате не назван — бери ближайшую такую дату В БУДУЩЕМ (речь о дате окончания подписки).
Примеры:
«удали Ивана PS Plus» → {"action":"delete","client_name":"Иван","sub_name":"PS Plus Extra","field":null,"value":null}
«измени дату Ивану на 5 сентября» → {"action":"update","client_name":"Иван","sub_name":null,"field":"expires_at","value":"2026-09-05"}
«телефон Ивана +7 900 123 45 67» → {"action":"update","client_name":"Иван","sub_name":null,"field":"contact","value":"+79001234567"}
«у Ивана аккаунт Денис» → {"action":"update","client_name":"Иван","sub_name":null,"field":"seller_account","value":"Денис"}
Чего нет в тексте — ставь null, не выдумывай.`;

export async function parseEdit(text) {
  const today = todayISO();
  const res = await chat([
    { role: 'system', content: EDIT_PROMPT.replace('{TODAY}', today) },
    { role: 'user', content: text },
  ]);
  const p = extractJson(res.content);
  if (!p || !p.client_name || !['delete', 'update'].includes(p.action)) {
    throw new Error('Не понял команду. Например: «удали Ивана PS Plus» или «измени дату Ивану на 5 сентября».');
  }
  p.client_name = String(p.client_name).trim().replace(/^@/, '').slice(0, 80);
  p.sub_name = p.sub_name ? String(p.sub_name).trim().slice(0, 60) : null;
  if (p.action === 'update') {
    if (!EDITABLE_FIELDS[p.field]) {
      throw new Error(`Не понял, что менять. Могу: ${Object.values(EDITABLE_FIELDS).join(', ')}.`);
    }
    if (p.value == null || String(p.value).trim() === '') {
      throw new Error(`Не понял новое значение для «${EDITABLE_FIELDS[p.field]}».`);
    }
    p.value = String(p.value).trim().slice(0, 300);
    // Значения из LLM идут прямо в базу — нормализуем и проверяем границы, как при разборе продажи
    if (p.field === 'expires_at') {
      const yearAgo = new Date(Date.now() - 366 * 86400000).toISOString().split('T')[0];
      const in4y = new Date(Date.now() + 4 * 366 * 86400000).toISOString().split('T')[0];
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(p.value) && !isNaN(Date.parse(p.value + 'T12:00:00Z'));
      if (!valid || p.value < yearAgo || p.value > in4y) {
        throw new Error(`Подозрительная дата: «${p.value}». Назови её явно, например «на 5 сентября 2026».`);
      }
    }
    if (p.field === 'contact') p.value = normPhone(p.value) || p.value;
    if (p.field === 'seller_account') p.value = p.value.replace(/^\s*(?:с\s+)?аккаунт[а-яё]*\s+/i, '').trim().replace(/^./, c => c.toUpperCase());
    if (p.field === 'client_link' && !/^https?:\/\//i.test(p.value)) {
      throw new Error(`Ссылка должна начинаться с https:// — получил «${p.value}».`);
    }
  }
  return p;
}

// Записи, подходящие под команду. Имя ищем подстрокой (падежи, приписки), подписку — фаззи.
// Возвращаем ВСЕ совпадения: выбор конкретной строки делает владелец кнопкой, не мы.
export async function findRecords({ client_name, sub_name }) {
  const { data, error } = await supabase
    .from('client_subs')
    .select('*')
    .ilike('client_name', `%${client_name.replace(/([%_\\])/g, '\\$1')}%`)
    .order('expires_at', { ascending: true })
    .limit(25);
  if (error) throw new Error(error.message);
  let rows = data || [];
  if (sub_name) {
    const bySub = rows.filter(r => sameSub(r.sub_name, sub_name));
    if (bySub.length) rows = bySub; // не сузилось — покажем всё, что нашли по имени
  }
  return rows;
}

export async function updateField(id, field, value) {
  if (!EDITABLE_FIELDS[field]) throw new Error(`Поле «${field}» править нельзя.`);
  const { data, error } = await supabase
    .from('client_subs')
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`Supabase: ${error.message}`);
  return data;
}

// Возврат удалённой записи (кнопка «↩️ Восстановить»). id будет новым — сама запись та же.
export async function reinsertRecord(row) {
  const { id, created_at, updated_at, ...rest } = row;
  const { data, error } = await supabase.from('client_subs').insert(rest).select().single();
  if (error) throw new Error(`Supabase: ${error.message}`);
  return data;
}

// Совпадение подписок: «Game Pass» ≈ «Game Pass Ultimate», но «PS Plus Extra» ≠ «PS Plus Essential»
function sameSub(a, b) {
  const na = String(a || '').toLowerCase().replace(/[^a-zа-я0-9]+/gi, ' ').trim();
  const nb = String(b || '').toLowerCase().replace(/[^a-zа-я0-9]+/gi, ' ').trim();
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

// Записи, которые может иметь в виду «продлил <имя> <подписка>».
// У клиента может быть несколько подписок — продлеваем только ту же самую, иначе
// «продлил Ивану Game Pass» перезаписал бы его запись о PS Plus. Нет совпадения
// по подписке → вызывающий код запишет продажу как новую (ничего чужого не трогаем).
export async function findRenewalCandidates(p) {
  const { data: existing } = await supabase
    .from('client_subs')
    .select('*')
    .ilike('client_name', p.client_name.replace(/([%_\\])/g, '\\$1')) // % и _ в имени — не wildcards
    .order('expires_at', { ascending: false })
    .limit(10);
  let candidates = (existing || []).filter(r => sameSub(r.sub_name, p.sub_name));
  // Тёзки с разных каналов: если канал назван — сужаем по нему
  if (candidates.length > 1 && p.channel !== 'other') {
    const byChannel = candidates.filter(r => r.channel === p.channel);
    if (byChannel.length) candidates = byChannel;
  }
  return candidates;
}

// Тёзки: под одно имя может подойти несколько РАЗНЫХ клиентов (два «Владимира» в Telegram).
// Собираем кандидатов по всем подпискам заметки и группируем по «личности» — ссылка на
// профиль, иначе заметка (там обычно телефон), иначе сама запись. Больше одной группы —
// продлевать вслепую нельзя: молчаливый выбор «у кого дата дальше» может продлить чужую.
export async function renewalIdentityGroups(p) {
  const groups = new Map();
  for (const sub of (p.subs?.length ? p.subs : [p.sub_name])) {
    for (const row of await findRenewalCandidates({ ...p, sub_name: sub })) {
      const key = row.client_link || row.note || `id:${row.id}`;
      if (!groups.has(key)) groups.set(key, { key, channel: row.channel, link: row.client_link, note: row.note, rows: [] });
      const g = groups.get(key);
      if (!g.rows.some(r => r.id === row.id)) g.rows.push(row);
    }
  }
  return [...groups.values()];
}

// Какую именно запись выбранного клиента продлевать под каждую подписку из заметки.
// Подходящей нет — этой подписки у него ещё не было, запишется новой строкой.
export function targetIdsFor(group, subs) {
  const map = {};
  for (const sub of subs) {
    const row = group.rows.find(r => sameSub(r.sub_name, sub));
    if (row) map[sub] = row.id;
  }
  return map;
}

// Сохраняет продажу. Для intent=renewal ищет существующую запись клиента и продлевает её.
// p.target_id — продлить именно эту запись (владелец выбрал кнопкой из тёзок).
// p.identity_locked — клиент уже выбран: не искать совпадений на стороне, при отсутствии
// target_id записать новую строку (у выбранного клиента этой подписки ещё не было).
// Возвращает { record, renewed, prevExpires }.
export async function recordSale(p) {
  if (p.intent === 'renewal') {
    let candidates = [];
    if (p.target_id) {
      const { data } = await supabase.from('client_subs').select('*').eq('id', p.target_id).limit(1);
      candidates = data || [];
    } else if (!p.identity_locked) {
      candidates = await findRenewalCandidates(p);
    }
    if (candidates.length) {
      const old = candidates[0];
      // Продление отсчитываем от текущей даты окончания, если она в будущем, иначе от сегодня.
      // Названная дата оформления («продлил с 18 января на год») перебивает обе.
      const base = p.start_date || (old.expires_at > todayISO() ? old.expires_at : todayISO());
      const expires = p.expires_date || addMonths(base, p.months);
      const { data, error } = await supabase
        .from('client_subs')
        .update({
          sub_name: p.sub_name || old.sub_name,
          expires_at: expires,
          months: p.months || old.months, // срок последней продажи — для кнопки «продлил на тот же срок»
          status: 'active',
          reminded_7d_at: null,
          reminded_0d_at: null,
          snooze_until: null,
          note: p.note || old.note,
          client_link: p.client_link || old.client_link,
          // Контакт/аккаунт/логин при продлении только дополняем: в заметке «продлил Ивану
          // на год» их обычно не повторяют, а затирать уже известный телефон нельзя —
          // для клиента без username это единственный способ его найти.
          contact: p.contact || old.contact,
          seller_account: p.seller_account || old.seller_account,
          account_login: p.account_login || old.account_login,
          updated_at: new Date().toISOString(),
        })
        .eq('id', old.id)
        .select()
        .single();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return { record: data, renewed: true, prevExpires: old.expires_at };
    }
  }
  // Срок отсчитываем от названной даты оформления, иначе от сегодня. Раньше поля start_date
  // не было и конец даты считала сама LLM — то верно, то молча от сегодняшнего числа.
  const expires = p.expires_date || addMonths(p.start_date || todayISO(), p.months);
  const { data, error } = await supabase
    .from('client_subs')
    .insert({
      client_name: p.client_name,
      channel: p.channel,
      client_link: p.client_link,
      sub_name: p.sub_name,
      expires_at: expires,
      months: p.months, // null, если срок задан датой
      contact: p.contact,
      seller_account: p.seller_account,
      account_login: p.account_login,
      note: p.note,
    })
    .select()
    .single();
  if (error) throw new Error(`Supabase: ${error.message}`);
  return { record: data, renewed: false, prevExpires: null };
}

// Заметка может называть несколько подписок сразу («ПС+ экстра и ЕА плэй на год») — каждая
// становится ОТДЕЛЬНОЙ записью: своё напоминание, своя кнопка продления, продление одной
// не затирает вторую (склеенное «PS Plus Extra, EA Play» в одном поле как раз затиралось —
// sameSub() матчил половину названия и переписывал всю запись).
// Пишем последовательно: параллельные продления одного клиента могли бы гоняться за одну строку.
export async function recordSales(p) {
  const saved = [];
  const failed = [];
  for (const sub of (p.subs?.length ? p.subs : [p.sub_name])) {
    try {
      saved.push(await recordSale({ ...p, sub_name: sub, target_id: p.target_ids?.[sub] || null }));
    } catch (e) {
      failed.push({ sub, message: e.message }); // одна не записалась — остальные не теряем
    }
  }
  if (!saved.length) throw new Error(failed.map(f => `${f.sub}: ${f.message}`).join('; '));
  return { saved, failed };
}

// Записи, по которым пора напомнить владельцу. Каждая попадает только в одну стадию.
export async function dueReminders() {
  const today = todayISO();
  const in5 = new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('client_subs')
    .select('*')
    .eq('status', 'active')
    .lte('expires_at', in5);
  if (error) { console.error('[crm] dueReminders:', error.message); return { stage0: [], stage7: [] }; }
  const rows = (data || []).filter(r => !r.snooze_until || r.snooze_until <= today);
  const stage0 = rows.filter(r => r.expires_at <= today && !r.reminded_0d_at);
  const stage0Ids = new Set(stage0.map(r => r.id));
  const stage7 = rows.filter(r => !r.reminded_7d_at && !stage0Ids.has(r.id) && r.expires_at > today);
  return { stage0, stage7 };
}

export async function markReminded(id, stage) {
  await supabase.from('client_subs')
    .update({ [stage === 0 ? 'reminded_0d_at' : 'reminded_7d_at']: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id);
}

export async function setStatus(id, status) {
  const { error } = await supabase.from('client_subs')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

// «Напомни завтра»: сдвигает snooze и сбрасывает отметку стадии, чтобы напоминание пришло снова
export async function snooze(id, stage) {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const { error } = await supabase.from('client_subs')
    .update({
      snooze_until: tomorrow,
      [stage === 0 ? 'reminded_0d_at' : 'reminded_7d_at']: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function removeRecord(id) {
  const { error } = await supabase.from('client_subs').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// Продление «на тот же срок» одной кнопкой из напоминания. Требует сохранённого months.
export async function renewSame(id) {
  const { data: old, error } = await supabase.from('client_subs').select('*').eq('id', id).single();
  if (error || !old) throw new Error('Запись не нашлась — возможно, удалена.');
  if (!old.months) throw new Error('Не знаю прежний срок — напиши «продлил …» текстом с указанием срока.');
  // Отсчитываем от текущей даты окончания, если она в будущем, иначе от сегодня
  const base = old.expires_at > todayISO() ? old.expires_at : todayISO();
  const { data, error: e2 } = await supabase
    .from('client_subs')
    .update({
      expires_at: addMonths(base, old.months),
      status: 'active',
      reminded_7d_at: null,
      reminded_0d_at: null,
      snooze_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
  if (e2) throw new Error(`Supabase: ${e2.message}`);
  return { record: data, prevExpires: old.expires_at };
}

export async function restoreExpires(id, prevExpires) {
  const { error } = await supabase.from('client_subs')
    .update({ expires_at: prevExpires, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function listClients() {
  const { data, error } = await supabase
    .from('client_subs')
    .select('*')
    .neq('status', 'lost')
    .order('expires_at', { ascending: true })
    // Лимит 25 обрезал список молча: клиенты с дальней датой окончания просто не показывались
    // (30.07.2026 — 63 активных записи, видно было 25). Отправка списка бьётся на несколько
    // сообщений, поэтому потолок TG в 4096 символов больше не ограничивает выборку.
    .limit(200);
  if (error) throw new Error(error.message);
  return data || [];
}

// Черновик сообщения клиенту о продлении — владелец копирует его в Авито/ВК/Телегу
export async function draftClientMessage(record) {
  const res = await chat([
    {
      role: 'system',
      content: `Ты пишешь короткое сообщение клиенту от лица продавца магазина игровых подписок «Поиграем?». Верни СТРОГО JSON: {"message": "текст"}. Задача сообщения: дружелюбно напомнить, что подписка скоро заканчивается (или уже закончилась), и предложить продлить её выгодно. 2–3 коротких предложения, на «ты», без канцелярита и давления, максимум один эмодзи. Не выдумывай цен и скидок в цифрах.`,
    },
    {
      role: 'user',
      content: `Клиент: ${record.client_name}. Подписка: ${record.sub_name}. Дата окончания: ${fmtDate(record.expires_at)} (${daysLeft(record.expires_at) >= 0 ? 'ещё не закончилась' : 'уже закончилась'}).`,
    },
  ]);
  const p = extractJson(res.content);
  return p?.message || String(res.content).trim();
}
