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
  "sub_name": string,                  // название подписки в общепринятом виде: "PS Plus Essential/Extra/Deluxe", "Game Pass Ultimate", "EA Play" и т.п.
  "months": number | null,             // срок в месяцах: «на год» = 12, «на 3 мес» = 3
  "expires_date": "YYYY-MM-DD" | null, // только если явно названа дата окончания
  "note": string | null                // прочие важные детали (цена, аккаунт и т.п.), иначе null
}
Сегодня {TODAY}. Чего нет в тексте — ставь null, не выдумывай.`;

// Разбирает текст владельца в структуру продажи. Бросает Error с человекочитаемым текстом.
export async function parseSale(text) {
  const res = await chat([
    { role: 'system', content: PARSE_PROMPT.replace('{TODAY}', todayISO()) },
    { role: 'user', content: text },
  ]);
  const p = extractJson(res.content);
  if (!p || !p.client_name || !p.sub_name) {
    throw new Error('Не смог разобрать запись. Напиши в формате: «продал Ивану с авито PS Plus Extra на 12 мес»');
  }
  if (!p.months && !p.expires_date) {
    throw new Error(`Не понял срок подписки для «${p.client_name} — ${p.sub_name}». Укажи, на сколько месяцев или до какой даты.`);
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
  if (!['avito', 'vk', 'tg', 'other'].includes(p.channel)) p.channel = 'other';
  p.client_name = String(p.client_name).trim().slice(0, 80);
  p.sub_name = String(p.sub_name).trim().slice(0, 60);
  if (p.client_name.startsWith('@')) p.client_name = p.client_name.slice(1);
  return p;
}

// Совпадение подписок: «Game Pass» ≈ «Game Pass Ultimate», но «PS Plus Extra» ≠ «PS Plus Essential»
function sameSub(a, b) {
  const na = String(a || '').toLowerCase().replace(/[^a-zа-я0-9]+/gi, ' ').trim();
  const nb = String(b || '').toLowerCase().replace(/[^a-zа-я0-9]+/gi, ' ').trim();
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

// Сохраняет продажу. Для intent=renewal ищет существующую запись клиента и продлевает её.
// Возвращает { record, renewed, prevExpires }.
export async function recordSale(p) {
  if (p.intent === 'renewal') {
    const { data: existing } = await supabase
      .from('client_subs')
      .select('*')
      .ilike('client_name', p.client_name.replace(/([%_\\])/g, '\\$1')) // % и _ в имени — не wildcards
      .order('expires_at', { ascending: false })
      .limit(10);
    // У клиента может быть несколько подписок — продлеваем только ту же самую, иначе
    // «продлил Ивану Game Pass» перезаписал бы его запись о PS Plus. Нет совпадения
    // по подписке → упадём вниз и запишем как новую (ничего чужого не трогаем).
    let candidates = (existing || []).filter(r => sameSub(r.sub_name, p.sub_name));
    // Тёзки с разных каналов: если канал назван — сужаем по нему
    if (candidates.length > 1 && p.channel !== 'other') {
      const byChannel = candidates.filter(r => r.channel === p.channel);
      if (byChannel.length) candidates = byChannel;
    }
    if (candidates.length) {
      const old = candidates[0];
      // Продление отсчитываем от текущей даты окончания, если она в будущем, иначе от сегодня
      const base = old.expires_at > todayISO() ? old.expires_at : todayISO();
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
          updated_at: new Date().toISOString(),
        })
        .eq('id', old.id)
        .select()
        .single();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return { record: data, renewed: true, prevExpires: old.expires_at };
    }
  }
  const expires = p.expires_date || addMonths(todayISO(), p.months);
  const { data, error } = await supabase
    .from('client_subs')
    .insert({
      client_name: p.client_name,
      channel: p.channel,
      client_link: p.client_link,
      sub_name: p.sub_name,
      expires_at: expires,
      months: p.months, // null, если срок задан датой
      note: p.note,
    })
    .select()
    .single();
  if (error) throw new Error(`Supabase: ${error.message}`);
  return { record: data, renewed: false, prevExpires: null };
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
    .limit(25);
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
