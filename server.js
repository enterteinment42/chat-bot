// Точка входа: HTTP-сервер, эндпоинты, rate limits, оркестрация запросов
import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { chat, bootstrapSettings, clearSettingsCache } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import { loadCatalog } from './catalog.js';
import { logConversation } from './logger.js';

const app = express();
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
const PORT = process.env.PORT || 3002;
const MAX_LEN = parseInt(process.env.MAX_MESSAGE_LENGTH) || 500;
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY_MESSAGES) || 10;

app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// nginx дописывает реальный IP клиента ПОСЛЕДНИМ элементом X-Forwarded-For
// (proxy_add_x_forwarded_for) — берём последний, а не первый, иначе клиент
// подделывает первый элемент и получает новый rate-limit бакет каждым запросом.
// TG-бот шлёт один элемент "tg-{chatId}" — не расщепляется, работает как ключ как прежде.
function clientKey(req) {
  const xff = req.headers['x-forwarded-for'];
  if (!xff) return req.ip;
  const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || req.ip;
}

function makeLimit(windowMs, max, message, retryAfter) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientKey,
    handler: (_req, res) => res.status(429).json({ error: 'rate_limited', message, retry_after: retryAfter }),
  });
}

const perMinute = makeLimit(60_000, parseInt(process.env.RATE_LIMIT_PER_MINUTE) || 5, 'Слишком много сообщений, подожди минуту.', 60);
const perDay = makeLimit(86_400_000, parseInt(process.env.RATE_LIMIT_PER_DAY) || 20, 'Достигнут лимит сообщений на сегодня.', 3600);
const reminderLimit = makeLimit(86_400_000, 10, 'Слишком много напоминаний, попробуй завтра.', 3600);

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'chatbot', version: '1.0.0' });
});

// POST /api/chat
app.post('/api/chat', perDay, perMinute, async (req, res) => {
  const { sessionId, messages, context, channel, knownSubs } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'bad_request', message: 'messages обязателен' });
  }
  const last = messages[messages.length - 1];
  if (last?.role !== 'user') {
    return res.status(400).json({ error: 'bad_request', message: 'Последнее сообщение должно быть от user' });
  }

  const recent = messages.slice(-MAX_HISTORY);
  // Каждое сообщение истории (не только последнее) должно быть строкой в пределах лимита —
  // иначе безразмерный текст уходит прямо в LLM-запрос (и частично в системный промт).
  const badMsg = recent.some(m => typeof m?.content !== 'string' || m.content.length > MAX_LEN);
  if (badMsg) {
    return res.status(400).json({ error: 'bad_request', message: `Сообщение слишком длинное (максимум ${MAX_LEN} символов)` });
  }

  // context.currentGameName и knownSubs подставляются прямо в системный промт —
  // ограничиваем размер, чтобы не раздувать запрос и не давать инъекцию через system-уровень
  const safeKnownSubs = Array.isArray(knownSubs)
    ? knownSubs.filter(s => typeof s === 'string' && s.length > 0 && s.length <= 60).slice(0, 10)
    : [];
  const safeContext = (context && typeof context.currentGameName === 'string' && context.currentGameName.length <= 200)
    ? context
    : undefined;

  // Контекст игры передаём только для первого сообщения в сессии
  const gameContext = recent.length === 1 ? safeContext : undefined;
  const catalog = await loadCatalog();
  const systemPrompt = buildSystemPrompt(catalog, { context: gameContext, sessionId, channel, priceLookupAvailable: true, knownSubs: safeKnownSubs });

  try {
    const result = await chat([{ role: 'system', content: systemPrompt }, ...recent], 'chatbot');

    let parsed;
    try {
      let raw = result.content.trim();
      // 1. Снимаем markdown-обёртку ```json … ```
      const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenced) raw = fenced[1].trim();
      else if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
      // 2. Убираем текст перед {
      const bStart = raw.indexOf('{');
      if (bStart > 0) raw = raw.slice(bStart);
      // 3. Bracket-matching: вырезаем ровно первый полный JSON-объект.
      // Надёжнее greedy-regex — не ломается от текста после } и от {} внутри строк.
      if (raw.startsWith('{')) {
        let depth = 0, inStr = false, esc = false, end = -1;
        for (let i = 0; i < raw.length; i++) {
          const c = raw[i];
          if (esc)                { esc = false; continue; }
          if (c === '\\' && inStr) { esc = true;  continue; }
          if (c === '"')           { inStr = !inStr; continue; }
          if (inStr)               continue;
          if (c === '{') depth++;
          else if (c === '}') { if (--depth === 0) { end = i; break; } }
        }
        if (end !== -1) raw = raw.slice(0, end + 1);
      }
      parsed = JSON.parse(raw);
    } catch {
      // Fallback: пытаемся вытащить хотя бы поле reply регексом
      const m = result.content.match(/"reply"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/);
      if (m) {
        try   { parsed = { reply: JSON.parse(`"${m[1]}"`), recommendations: [] }; }
        catch { parsed = { reply: m[1].replace(/\\n/g, '\n'), recommendations: [] }; }
      } else {
        const t = result.content.trim();
        // Если контент выглядит как JSON — не показываем его как текст
        parsed = { reply: t.startsWith('{') ? '' : t, recommendations: [] };
      }
    }

    const reply = parsed.reply || '';
    // Сверка inCatalog с реальным каталогом — в обе стороны
    const catalogIds = new Set((catalog?.games || []).map(g => g.id));
    const _norm = s => (s || '').toLowerCase().replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
    const titleToId = new Map((catalog?.games || []).map(g => [_norm(g.title), g.id]));
    const recommendations = (Array.isArray(parsed.recommendations) ? parsed.recommendations : []).map(rec => {
      // Понижение: gameId не из каталога → не в каталоге (защита от галлюцинации)
      if (rec.inCatalog && rec.gameId && !catalogIds.has(rec.gameId)) {
        const { gameId, promo, ...rest } = rec;
        rec = { ...rest, inCatalog: false };
      }
      // Повышение (ОШ-5): реальная каталожная игра помечена не в каталоге → возвращаем флаг и gameId по точному названию
      if (!rec.inCatalog || !rec.gameId) {
        const id = titleToId.get(_norm(rec.title));
        if (id) rec = { ...rec, inCatalog: true, gameId: id };
      }
      return rec;
    });
    const escalate = parsed.escalate || null;
    // Если модель не вывела action/metadata — пробуем определить сами по паттернам
    const action   = parsed.action   || _detectSubReminderAction(reply, recent);
    const metadata = parsed.metadata || _detectSubMetadata(recent, Array.isArray(knownSubs) ? knownSubs : []);
    const usage = {
      input_tokens: result.usage?.prompt_tokens ?? result.usage?.input_tokens ?? 0,
      output_tokens: result.usage?.completion_tokens ?? result.usage?.output_tokens ?? 0,
      provider: result.provider,
      model: result.model,
    };

    logConversation({
      sessionId,
      ip: clientKey(req),
      messages: recent,
      recommendations,
      usage,
    });

    return res.json({ reply, recommendations, escalate, action, metadata, usage });
  } catch (err) {
    const userId = clientKey(req) || sessionId || 'unknown';
    const isTimeout = err.message?.toLowerCase().includes('timeout') || err.name === 'AbortError';
    console.error(`[${new Date().toISOString()}] LLM error | user=${userId} | type=${isTimeout ? 'timeout' : (err.name || 'unknown')} | ${err.message}`);
    return res.status(503).json({ error: 'llm_unavailable', message: 'Что-то пошло не так, напиши ещё раз — отвечу' });
  }
});

// GET /admin/settings — текущий провайдер и модель чатбота
app.get('/admin/settings', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { data, error } = await supabaseAdmin
    .from('settings').select('key, value')
    .in('key', ['chatbot_provider', 'chatbot_model']);
  if (error) return res.status(500).json({ error: error.message });
  const map = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  res.json({
    provider: map.chatbot_provider || 'openrouter',
    model: map.chatbot_model || 'anthropic/claude-haiku-4-5',
  });
});

// POST /admin/settings — сменить провайдера и модель без рестарта
app.post('/admin/settings', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { provider, model } = req.body || {};
  if (!provider || !model) {
    return res.status(400).json({ error: 'provider и model обязательны' });
  }
  const { error } = await supabaseAdmin.from('settings').upsert([
    { key: 'chatbot_provider', value: provider },
    { key: 'chatbot_model', value: model },
  ], { onConflict: 'key' });
  if (error) return res.status(500).json({ error: error.message });
  clearSettingsCache('chatbot');
  res.json({ ok: true, provider, model });
});

app.get('/admin/logs', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { data, error } = await supabaseAdmin
    .from('chat_conversations')
    .select('session_id, messages, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Хелперы для авто-определения action/metadata когда модель не вывела поля
const _SUB_NAMES = ['EA Play', 'PS Plus Deluxe', 'PS Plus Extra', 'PS Plus Essential', 'PS Plus', 'Xbox Game Pass'];
const _RU_MONTHS = {
  'январ': ['01', 31], 'феврал': ['02', 28], 'март': ['03', 31], 'апрел': ['04', 30],
  'ма': ['05', 31], 'июн': ['06', 30], 'июл': ['07', 31], 'август': ['08', 31],
  'сентябр': ['09', 30], 'октябр': ['10', 31], 'ноябр': ['11', 30], 'декабр': ['12', 31],
};

function _parseRuDate(text) {
  const t = text.toLowerCase();
  const now = new Date();
  const y = now.getFullYear();
  // "через месяц"
  if (/через\s+месяц/.test(t)) {
    return new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  }
  // "20 сентября" / "20 сентябре"
  const dm = t.match(/(\d{1,2})\s+([а-яё]+)/);
  if (dm) {
    const day = dm[1].padStart(2, '0');
    const stem = dm[2].slice(0, 5);
    for (const [key, [mon]] of Object.entries(_RU_MONTHS)) {
      if (stem.startsWith(key.slice(0, 4))) {
        const yr = new Date(`${y}-${mon}-${day}`) < now ? y + 1 : y;
        return `${yr}-${mon}-${day}`;
      }
    }
  }
  // "в сентябре" / "сентябрь"
  for (const [key, [mon, days]] of Object.entries(_RU_MONTHS)) {
    if (t.includes(key)) {
      const d = new Date(`${y}-${mon}-${days}`);
      const yr = d < now ? y + 1 : y;
      return `${yr}-${mon}-${String(days).padStart(2, '0')}`;
    }
  }
  return null;
}

function _extractSubName(messages) {
  const text = messages.map(m => m.content || '').join(' ');
  for (const s of _SUB_NAMES) {
    if (text.toLowerCase().includes(s.toLowerCase())) return s;
  }
  return null;
}

function _detectSubReminderAction(reply, messages) {
  if (!/напомн/i.test(reply)) return null;
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const expiresAt = _parseRuDate(lastUser);
  if (!expiresAt) return null;
  const subName = _extractSubName(messages);
  if (!subName) return null;
  return { type: 'sub_reminder', subName, expiresAt };
}

function _detectSubMetadata(messages, knownSubs) {
  if (knownSubs.length > 0) return null; // уже знаем
  // Ищем сообщение пользователя с явным указанием подписки
  const userText = messages.filter(m => m.role === 'user').map(m => m.content || '').join(' ');
  if (!/(у меня|есть|пользуюсь|подписка)/i.test(userText)) return null;
  const subName = _extractSubName(messages);
  if (!subName) return null;
  return { knownSubs: [subName] };
}

// POST /api/sub-reminder/init — создать напоминание об окончании подписки
app.post('/api/sub-reminder/init', reminderLimit, async (req, res) => {
  const { subName, expiresAt } = req.body || {};
  if (!subName || !expiresAt) return res.status(400).json({ error: 'subName and expiresAt required' });
  const expiresMs = Date.parse(expiresAt);
  const fiveYears = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000;
  if (Number.isNaN(expiresMs) || expiresMs < Date.now() || expiresMs > fiveYears) {
    return res.status(400).json({ error: 'bad_request', message: 'expiresAt должен быть корректной датой в будущем' });
  }
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  try {
    const { error } = await supabaseAdmin.from('sub_reminders').insert({
      token,
      sub_name:   String(subName).trim().slice(0, 100),
      expires_at: expiresAt,
      active:     false,
      created_at: new Date().toISOString(),
    });
    if (error) throw error;
    res.json({ token });
  } catch (e) {
    console.error('sub-reminder init failed:', e.message);
    res.status(500).json({ error: 'Не удалось создать напоминание' });
  }
});

bootstrapSettings().catch(err => console.warn('Bootstrap (non-fatal):', err.message));

app.listen(PORT, () => console.log(`Chatbot запущен на порту ${PORT}`));
