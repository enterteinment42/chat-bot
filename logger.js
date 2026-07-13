// Логирование разговоров в таблицу chat_conversations.
// IP хранится только как sha256-hash (не сырой).
// Один ряд на сессию — upsert по session_id при каждом сообщении.
// Ошибка записи не блокирует основной поток (fire-and-forget).

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import ws from 'ws';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });

function hashIp(ip) {
  // Соль = SUPABASE_URL, чтобы хеши не совпадали с другими проектами
  return createHash('sha256').update(ip + (process.env.SUPABASE_URL || '')).digest('hex');
}

export function logConversation({ sessionId, ip, messages, recommendations, usage }) {
  if (process.env.LOG_ALL_CONVERSATIONS === 'false') return;

  // Fire-and-forget: не ждём, не блокируем ответ клиенту
  supabase.from('chat_conversations').upsert({
    session_id: sessionId,
    ip_hash: ip ? hashIp(ip) : null,
    last_message_at: new Date().toISOString(),
    messages,
    recommendations: recommendations || [],
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    model_used: usage?.model || null,
  }, { onConflict: 'session_id' }).then(({ error }) => {
    if (error) console.warn('Logger:', error.message);
  });
}
