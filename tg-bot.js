// TG-обёртка поверх /api/chat
// Polling через обычный api.telegram.org — без локального tg-api, без конфликтов с webhook-ботами

import 'dotenv/config';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import * as crm from './crm.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });

const TG_TOKEN = process.env.CHATBOT_TG_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const TG_API   = `https://api.telegram.org/bot${TG_TOKEN}`;
const CHAT_API = `http://localhost:${process.env.PORT || 3002}/api/chat`;
const MAX_HIST = parseInt(process.env.MAX_HISTORY_MESSAGES) || 10;

// История диалогов в памяти: chatId → [{role, content}]
const sessions = new Map();

// Простой антиспам: не более 1 сообщения в 2 сек на пользователя
const lastMsg = new Map();
const COOLDOWN_MS = 2000;

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Экранирует HTML и конвертирует **bold** → <b>bold</b> для parse_mode: HTML
function formatForTg(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

async function tg(method, body = {}) {
  const r = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  // Без этой проверки неудачная отправка (юзер заблокировал бота и т.п.) выглядит
  // как успех для вызывающего кода — критично для checkSubReminders (напоминание терялось молча)
  if (!data.ok) throw new Error(`TG API ${method} failed: ${data.description || r.status}`);
  return data;
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text   = msg.text?.trim();
  if (!text) return;

  // Мини-CRM: команды владельца (все остальные его сообщения идут обычным путём — бота можно тестировать)
  if (ADMIN_CHAT_ID && chatId === ADMIN_CHAT_ID) {
    if (/^(\/clients|клиенты)$/i.test(text)) {
      await sendClientList(chatId);
      return;
    }
    if (/^(продал|продлил|\/sold)\b/i.test(text)) {
      await handleAdminSale(chatId, text);
      return;
    }
  }

  // /start w_TOKEN — deep link «Следить за скидкой» из price-lookup
  if (text.startsWith('/start w_')) {
    const token = text.slice(9).trim();
    const { data, error } = await supabase
      .from('price_watchlist')
      .update({ tg_chat_id: chatId, active: true })
      .eq('token', token)
      .eq('active', false)
      .select('game_name, price_at_subscribe_rub')
      .single();
    if (!error && data) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `Запомнил! Слежу за <b>${escapeHtml(data.game_name)}</b> — напишу когда цена упадёт на 15%+ от ${data.price_at_subscribe_rub.toLocaleString('ru-RU')} ₽.`,
        parse_mode: 'HTML',
      });
    } else {
      await tg('sendMessage', { chat_id: chatId, text: 'Ссылка устарела или уже использована. Попробуй заново через сайт.' });
    }
    return;
  }

  // /start r_TOKEN — deep link «Напомни о продлении подписки»
  if (text.startsWith('/start r_')) {
    const token = text.slice(9).trim();
    const { data, error } = await supabase
      .from('sub_reminders')
      .update({ tg_chat_id: chatId, active: true })
      .eq('token', token)
      .eq('active', false)
      .select('sub_name, expires_at')
      .single();
    if (!error && data) {
      const exDate = new Date(data.expires_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
      await tg('sendMessage', {
        chat_id: chatId,
        text: `Запомнил! Напомню за 5 дней до окончания <b>${escapeHtml(data.sub_name)}</b> — ${exDate}.`,
        parse_mode: 'HTML',
      });
    } else {
      await tg('sendMessage', { chat_id: chatId, text: 'Ссылка устарела или уже использована. Попробуй заново через чат.' });
    }
    return;
  }

  // /start — сбросить историю
  if (text === '/start') {
    sessions.delete(chatId);
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Привет! Помогу подобрать игру 🎮 Расскажи, что тебя интересует?',
    });
    return;
  }

  // Антиспам
  const now = Date.now();
  if (lastMsg.has(chatId) && now - lastMsg.get(chatId) < COOLDOWN_MS) return;
  lastMsg.set(chatId, now);

  // История сессии
  if (!sessions.has(chatId)) sessions.set(chatId, []);
  const history = sessions.get(chatId);
  history.push({ role: 'user', content: text });

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  try {
    const r = await fetch(CHAT_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Передаём chatId как "IP" — каждый пользователь получает свой rate-limit бакет
        'X-Forwarded-For': `tg-${chatId}`,
      },
      body: JSON.stringify({
        sessionId: String(chatId),
        messages: history.slice(-MAX_HIST),
        channel: 'telegram',
      }),
    });

    const data = await r.json();

    if (data.error === 'rate_limited') {
      await tg('sendMessage', { chat_id: chatId, text: data.message || 'Слишком много сообщений, подожди немного.' });
      history.pop();
      return;
    }

    if (data.error) {
      await tg('sendMessage', { chat_id: chatId, text: 'Бот сейчас отдыхает, попробуй через минутку 🙏' });
      history.pop();
      return;
    }

    const reply = data.reply || '';

    // Пустой ответ от LLM — не отправляем пустое сообщение в Telegram (вызовет 400)
    if (!reply.trim()) {
      await tg('sendMessage', { chat_id: chatId, text: 'Не могу ответить прямо сейчас, попробуй переформулировать 🤔' });
      history.pop();
      return;
    }

    history.push({ role: 'assistant', content: reply });

    // Обрезаем историю чтобы не росла бесконечно
    if (history.length > MAX_HIST * 2) history.splice(0, history.length - MAX_HIST * 2);

    // Inline-кнопки
    const msg = { chat_id: chatId, text: formatForTg(reply), parse_mode: 'HTML' };
    const inlineRows = [];
    if (data.escalate?.target === 'price_lookup') {
      inlineRows.push([{ text: '🔍 Узнать цену', url: 'https://api.poigraem.shop/price-lookup/' }]);
    }
    if (data.action?.type === 'sub_reminder') {
      const cbData = `remind:${data.action.subName}:${data.action.expiresAt}`;
      inlineRows.push([{ text: `🔔 Напомнить за 5 дней до окончания ${data.action.subName}`, callback_data: cbData }]);
    }
    if (inlineRows.length) msg.reply_markup = { inline_keyboard: inlineRows };
    await tg('sendMessage', msg);
  } catch (err) {
    console.error('TG bot error:', err.message);
    await tg('sendMessage', { chat_id: chatId, text: 'Что-то пошло не так, попробуй ещё раз.' });
    history.pop();
  }
}

async function poll() {
  if (!TG_TOKEN) { console.error('CHATBOT_TG_TOKEN не задан'); process.exit(1); }
  let offset = 0;
  console.log('TG-бот запущен (polling)');

  while (true) {
    try {
      const data = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      if (data.result?.length) {
        for (const upd of data.result) {
          offset = upd.update_id + 1;
          if (upd.message)        handleMessage(upd.message).catch(e => console.error('handle error:', e.message));
          if (upd.callback_query) handleCallback(upd.callback_query).catch(e => console.error('callback error:', e.message));
        }
      }
    } catch (err) {
      console.error('Polling error:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function handleCallback(cbq) {
  const chatId = cbq.message?.chat?.id;
  const data   = cbq.data || '';

  // Кнопки мини-CRM — только для владельца
  if (data.startsWith('cs:')) {
    if (cbq.from?.id !== ADMIN_CHAT_ID) {
      await tg('answerCallbackQuery', { callback_query_id: cbq.id });
      return;
    }
    const [, action, id, extra] = data.split(':');
    let answer = 'Готово';
    try {
      if (action === 'ok')  { await crm.setStatus(Number(id), 'contacted'); answer = 'Отметил: написал ✅'; }
      if (action === 'no')  { await crm.setStatus(Number(id), 'lost'); answer = 'Отметил: не продлил'; }
      if (action === 'tm')  { await crm.snooze(Number(id), Number(extra)); answer = 'Напомню завтра 🔁'; }
      if (action === 'del') { await crm.removeRecord(Number(id)); answer = 'Запись удалена'; }
      if (action === 'rvt') { await crm.restoreExpires(Number(id), extra); answer = `Вернул дату: ${crm.fmtDate(extra)}`; }
      // Убираем кнопки, чтобы не нажать повторно
      if (cbq.message) {
        await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cbq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
    } catch (e) {
      console.error('[crm callback]', e.message);
      answer = `Ошибка: ${e.message}`.slice(0, 190);
    }
    await tg('answerCallbackQuery', { callback_query_id: cbq.id, text: answer });
    return;
  }

  await tg('answerCallbackQuery', { callback_query_id: cbq.id });
  if (!chatId) return;

  if (data.startsWith('remind:')) {
    const [, subName, expiresAt] = data.split(':');
    if (!subName || !expiresAt) return;
    try {
      const { error } = await supabase.from('sub_reminders').insert({
        token:      crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        sub_name:   subName,
        expires_at: expiresAt,
        tg_chat_id: chatId,
        active:     true,
        created_at: new Date().toISOString(),
      });
      if (error) throw error;
      const exDate = new Date(expiresAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
      await tg('sendMessage', {
        chat_id: chatId,
        text: `Запомнил! Напомню за 5 дней до окончания <b>${escapeHtml(subName)}</b> — ${exDate}.`,
        parse_mode: 'HTML',
      });
    } catch (e) {
      console.error('[sub-reminder callback]', e.message);
      await tg('sendMessage', { chat_id: chatId, text: 'Не удалось создать напоминание, попробуй ещё раз.' });
    }
  }
}

// ===== Мини-CRM: подписки клиентов и напоминания владельцу =====

// Имя клиента для сообщений: ссылкой, если она есть
function clientLabel(r) {
  const name = escapeHtml(r.client_name);
  const channel = crm.CHANNEL_LABELS[r.channel] || r.channel;
  return (r.client_link ? `<a href="${escapeHtml(r.client_link)}">${name}</a>` : `<b>${name}</b>`) + ` (${channel})`;
}

// «продал/продлил ...» — разбор через LLM, запись в client_subs, карточка-подтверждение
async function handleAdminSale(chatId, text) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const parsed = await crm.parseSale(text);
    const { record, renewed, prevExpires } = await crm.recordSale(parsed);
    let card = `${renewed ? '🔁 Продлил' : '✅ Записал'}: ${clientLabel(record)} — <b>${escapeHtml(record.sub_name)}</b> до ${crm.fmtDate(record.expires_at)}`;
    if (renewed) card += `\n(было до ${crm.fmtDate(prevExpires)})`;
    if (record.note) card += `\n📝 ${escapeHtml(record.note)}`;
    card += `\n\nНапомню за 7 дней до окончания и в день окончания. Список: /clients`;
    const buttons = renewed
      ? [[{ text: '↩️ Вернуть прежнюю дату', callback_data: `cs:rvt:${record.id}:${prevExpires}` }]]
      : [[{ text: '❌ Отменить запись', callback_data: `cs:del:${record.id}` }]];
    await tg('sendMessage', { chat_id: chatId, text: card, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    console.error('[crm sale]', e.message);
    await tg('sendMessage', { chat_id: chatId, text: `⚠️ ${e.message}` });
  }
}

async function sendClientList(chatId) {
  try {
    const rows = await crm.listClients();
    if (!rows.length) {
      await tg('sendMessage', { chat_id: chatId, text: 'Записей пока нет. Добавь первую: «продал Ивану с авито PS Plus Extra на 12 мес»' });
      return;
    }
    const statusMark = { active: '', contacted: ' ✉️ написал', renewed: ' 🔁' };
    const lines = rows.map(r => {
      const d = crm.daysLeft(r.expires_at);
      const when = d < 0 ? `закончилась ${crm.fmtDate(r.expires_at)} ❗️` : d === 0 ? 'заканчивается сегодня ❗️' : `до ${crm.fmtDate(r.expires_at)} (через ${d} дн)`;
      return `• ${clientLabel(r)} — ${escapeHtml(r.sub_name)}, ${when}${statusMark[r.status] || ''}`;
    });
    await tg('sendMessage', { chat_id: chatId, text: `📋 <b>Подписки клиентов</b>\n\n${lines.join('\n')}`, parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) {
    console.error('[crm list]', e.message);
    await tg('sendMessage', { chat_id: chatId, text: `⚠️ Не удалось получить список: ${e.message}` });
  }
}

// Ежедневно: напоминания владельцу за 7 дней и в день окончания, с черновиком сообщения клиенту
async function checkClientSubs() {
  if (!ADMIN_CHAT_ID) return;
  try {
    const { stage7, stage0 } = await crm.dueReminders();
    for (const [stage, rows] of [[7, stage7], [0, stage0]]) {
      for (const r of rows) {
        try {
          const d = crm.daysLeft(r.expires_at);
          const when = d > 0 ? `через ${d} дн (${crm.fmtDate(r.expires_at)})` : d === 0 ? '<b>сегодня</b>' : `уже закончилась ${crm.fmtDate(r.expires_at)} ❗️`;
          let text = `⏰ У ${clientLabel(r)} ${d < 0 ? '' : 'заканчивается '}<b>${escapeHtml(r.sub_name)}</b> — ${when}.`;
          try {
            const draft = await crm.draftClientMessage(r);
            text += `\n\nЧерновик для клиента (тапни — скопируется):\n<code>${escapeHtml(draft)}</code>`;
          } catch (e) {
            console.error('[crm draft]', e.message);
          }
          await tg('sendMessage', {
            chat_id: ADMIN_CHAT_ID,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [[
              { text: '✅ Написал', callback_data: `cs:ok:${r.id}` },
              { text: '🔁 Завтра', callback_data: `cs:tm:${r.id}:${stage}` },
              { text: '❌ Не продлил', callback_data: `cs:no:${r.id}` },
            ]] },
          });
          await crm.markReminded(r.id, stage);
          console.log(`[crm] reminder stage=${stage} id=${r.id} "${r.client_name}"`);
        } catch (e) {
          console.error('[crm remind]', e.message);
        }
      }
    }
  } catch (e) {
    console.error('[crm check]', e.message);
  }
}

// Ежедневная проверка истекающих подписок — уведомляем за 5 дней
async function checkSubReminders() {
  const fiveDays = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const { data: reminders, error } = await supabase
    .from('sub_reminders')
    .select('*')
    .eq('active', true)
    .is('reminded_at', null)
    .lte('expires_at', fiveDays);
  if (error || !reminders?.length) return;
  for (const r of reminders) {
    try {
      const exDate = new Date(r.expires_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
      await tg('sendMessage', {
        chat_id: r.tg_chat_id,
        text: `📅 Напоминание: подписка <b>${escapeHtml(r.sub_name)}</b> заканчивается ${exDate}.\n\nНе забудь продлить!`,
        parse_mode: 'HTML',
      });
      await supabase.from('sub_reminders')
        .update({ reminded_at: new Date().toISOString(), active: false })
        .eq('id', r.id);
      console.log(`[sub-reminder] notified chat_id=${r.tg_chat_id} for "${r.sub_name}"`);
    } catch (e) {
      console.error('[sub-reminder]', e.message);
    }
  }
}

setInterval(checkSubReminders, 24 * 60 * 60 * 1000);
checkSubReminders();

setInterval(checkClientSubs, 24 * 60 * 60 * 1000);
checkClientSubs();

poll();
