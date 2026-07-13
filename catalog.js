// Загрузка и нормализация каталога игр + подписок из Supabase (read-only).
// Кешируется в памяти на 1 час. При недоступности возвращает null — бот работает без каталога.

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { realtime: { transport: ws } });

let _cache = null;
let _cacheTime = 0;
const TTL = 60 * 60 * 1000; // 1 час

export async function loadCatalog() {
  const now = Date.now();
  if (_cache && now - _cacheTime < TTL) return _cache;

  try {
    // Грузим всё параллельно
    const [snapResult, hierResult, subGamesResult] = await Promise.all([
      supabase.from('store_snapshot').select('data').eq('id', 'main').single(),
      supabase.from('subscription_hierarchy').select('*'),
      supabase.from('subscription_games').select('subscription_key, game_title, platform'),
    ]);

    if (snapResult.error || !snapResult.data) {
      console.warn('Catalog: не удалось загрузить снапшот:', snapResult.error?.message);
      return null;
    }

    // --- Игры каталога ---
    const snap = snapResult.data.data;
    const descriptions = snap.descriptions || {};

    const games = (snap.games || [])
      .filter(g => !g.hidden)
      .map(g => ({
        id: String(g.id),
        title: g.title,
        priceRUB: g.priceRUB || 0,
        discount: g.discount || null,
        isNew: !!g.isNew,
        popular: !!g.popular,
        featured: !!g.featured,
        description: descriptions[g.title] || null,
      }));

    // --- Подписки ---
    // Группируем игры подписок по ключу
    const gamesByKey = {};
    for (const g of (subGamesResult.data || [])) {
      const key = g.subscription_key;
      if (!gamesByKey[key]) gamesByKey[key] = [];
      gamesByKey[key].push({ title: g.game_title, platform: g.platform });
    }

    // Прикрепляем игры к каждой подписке из иерархии
    const subscriptions = (hierResult.data || []).map(sub => ({
      ...sub,
      games: gamesByKey[sub.key] || gamesByKey[sub.subscription_key] || [],
    }));

    if (hierResult.error) console.warn('Catalog: ошибка загрузки подписок:', hierResult.error?.message);
    if (subGamesResult.error) console.warn('Catalog: ошибка загрузки игр подписок:', subGamesResult.error?.message);

    const subscriptionPrices = (snap.subs || [])
      .filter(s => s.active)
      .map(s => ({ id: s.id, name: s.name, plans: s.plans }));

    _cache = { games, subscriptions, subscriptionPrices, loadedAt: new Date().toISOString() };
    _cacheTime = now;
    console.log(`Catalog: ${games.length} игр, ${subscriptions.length} подписок, ${subscriptionPrices.length} подписок с ценами`);
    return _cache;

  } catch (err) {
    console.warn('Catalog: ошибка загрузки (non-fatal):', err.message);
    return null;
  }
}
