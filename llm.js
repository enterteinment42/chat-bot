// Абстракция над тремя провайдерами: OpenRouter, Anthropic Direct, Google Gemini Direct.
// Провайдер и модель читаются из таблицы settings в Supabase (runtime без рестарта).
// Двусторонний fallback только между Anthropic-каналами.

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { realtime: { transport: ws } });

const openrouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://poigraem.shop',
    'X-Title': 'Poigraem Chatbot',
  },
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const gemini = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});

const LLM_TIMEOUT_MS = 30_000;

// Маппинг для двустороннего fallback — только Anthropic-модели
const OPENROUTER_TO_ANTHROPIC = {
  'anthropic/claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'anthropic/claude-sonnet-4-6': 'claude-sonnet-4-6',
};
const ANTHROPIC_TO_OPENROUTER = {
  'claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4-5',
  'claude-haiku-4-5': 'anthropic/claude-haiku-4-5',
  'claude-sonnet-4-6': 'anthropic/claude-sonnet-4-6',
};

// Кеш настроек, TTL 60 сек
const settingsCache = {};

export function clearSettingsCache(feature = 'chatbot') {
  delete settingsCache[feature];
}

async function getSettings(feature) {
  const now = Date.now();
  if (settingsCache[feature] && now - settingsCache[feature].time < 60_000) {
    return settingsCache[feature].data;
  }

  const { data } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', [`${feature}_provider`, `${feature}_model`]);

  const map = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  const result = {
    provider: map[`${feature}_provider`] || process.env.DEFAULT_CHATBOT_PROVIDER || 'openrouter',
    model: map[`${feature}_model`] || process.env.DEFAULT_CHATBOT_MODEL || 'anthropic/claude-haiku-4-5',
  };

  settingsCache[feature] = { data: result, time: now };
  return result;
}

// Записывает дефолты в settings если их ещё нет. Может упасть из-за RLS — это не критично.
export async function bootstrapSettings() {
  try {
    const { data } = await supabase
      .from('settings')
      .select('key')
      .in('key', ['chatbot_provider', 'chatbot_model']);

    const existing = new Set((data || []).map(r => r.key));
    const inserts = [];

    if (!existing.has('chatbot_provider')) {
      inserts.push({ key: 'chatbot_provider', value: process.env.DEFAULT_CHATBOT_PROVIDER || 'openrouter' });
    }
    if (!existing.has('chatbot_model')) {
      inserts.push({ key: 'chatbot_model', value: process.env.DEFAULT_CHATBOT_MODEL || 'anthropic/claude-haiku-4-5' });
    }

    if (inserts.length > 0) {
      const { error } = await supabase.from('settings').insert(inserts);
      if (error) {
        console.warn('Bootstrap: не удалось записать дефолты в settings:', error.message);
      } else {
        console.log('Bootstrap: записаны дефолты:', inserts.map(i => i.key).join(', '));
      }
    }
  } catch (err) {
    console.warn('Bootstrap (non-fatal):', err.message);
  }
}

async function callOpenRouter(messages, model) {
  // reasoning.effort:'none' — отключаем «размышления» (для подбора игр глубокое рассуждение не нужно).
  // У DeepSeek V4 Pro это срезает 11-20с задержку; для моделей без reasoning OpenRouter параметр игнорирует.
  // response_format json_object — нативный JSON-режим: модель физически не может вернуть прозу вне объекта
  // (лечит «думает вслух» у Gemini и повышает надёжность формата у всех моделей). Форму задаёт промт.
  const resp = await openrouter.chat.completions.create({ model, messages, max_tokens: 1024, reasoning: { effort: 'none' }, response_format: { type: 'json_object' } }, { timeout: LLM_TIMEOUT_MS });
  return {
    content: resp.choices[0].message.content,
    usage: resp.usage,
    provider: 'openrouter',
    model,
  };
}

async function callGemini(messages, model) {
  // response_format json_object — тот же нативный JSON-режим, что и в OpenRouter:
  // без него Gemini «думает вслух» и ломает формат (баг сессий 20-21).
  const resp = await gemini.chat.completions.create({ model, messages, max_tokens: 1024, response_format: { type: 'json_object' } }, { timeout: LLM_TIMEOUT_MS });
  return {
    content: resp.choices[0].message.content,
    usage: resp.usage,
    provider: 'gemini',
    model,
  };
}

async function callAnthropic(messages, model) {
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system');

  const resp = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    // Prompt caching для системного промта — экономит ~70% токенов при повторных запросах
    system: systemMsg
      ? [{ type: 'text', text: systemMsg.content, cache_control: { type: 'ephemeral' } }]
      : undefined,
    messages: chatMessages,
  }, { timeout: LLM_TIMEOUT_MS });

  return {
    content: resp.content[0].text,
    usage: resp.usage,
    provider: 'anthropic',
    model,
  };
}

export async function chat(messages, feature = 'chatbot') {
  const { provider, model } = await getSettings(feature);

  const callByProvider = (p, m) => {
    if (p === 'openrouter') return callOpenRouter(messages, m);
    if (p === 'gemini') return callGemini(messages, m);
    return callAnthropic(messages, m);
  };

  try {
    return await callByProvider(provider, model);
  } catch (primaryErr) {
    // Fallback только между Anthropic-каналами; для gemini и не-Anthropic OpenRouter — ошибка
    const fallbackModel = provider === 'openrouter'
      ? OPENROUTER_TO_ANTHROPIC[model]
      : provider === 'anthropic'
        ? ANTHROPIC_TO_OPENROUTER[model]
        : null;

    if (!fallbackModel) throw primaryErr;

    const fallbackProvider = provider === 'openrouter' ? 'anthropic' : 'openrouter';
    console.warn(`${provider} упал (${primaryErr.message}), fallback → ${fallbackProvider} / ${fallbackModel}`);
    return await callByProvider(fallbackProvider, fallbackModel);
  }
}
