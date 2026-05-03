#!/usr/bin/env node
/**
 * Helper for the post agent: select N products to post.
 *
 * Slot layout (for --count 7):
 *   - Reserved slots (1-2): seasonal/evergreen keywords from runtime-tuning.json
 *   - Genre slots (remaining): weighted-random pick from all active genres
 *
 * Shop diversity: no duplicate shops within the same batch.
 */
import fs from 'fs';
import { config } from '../src/config.mjs';
import {
  getUnpostedProducts,
  getUnpostedProductsByGenre,
  getActiveGenres,
  getLatestStrategy,
  getTodayPostCount,
} from '../src/db.mjs';
import { fetchRanking, searchProductsAPI } from '../src/searcher.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--count');
  return { count: i >= 0 ? parseInt(args[i + 1], 10) : 7 };
}

function loadTuning() {
  try {
    const p = new URL('../data/runtime-tuning.json', import.meta.url);
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return {}; }
}

function weightedSample(items, count, floor = 0.05) {
  const pool = items.map(it => ({ ...it, weight: Math.max(floor, it.weight) }));
  const picked = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const total = pool.reduce((s, it) => s + it.weight, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      r -= pool[idx].weight;
      if (r <= 0) break;
    }
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

async function main() {
  const { count: requested } = parseArgs();
  const todayCount = getTodayPostCount();
  const remaining = Math.max(0, config.posting.dailyLimit - todayCount);
  const toPost = Math.min(requested, remaining);

  if (toPost === 0) {
    process.stdout.write(JSON.stringify({ count: 0, products: [], reason: 'daily_limit_reached', todayCount }) + '\n');
    return;
  }

  const tuning = loadTuning();
  const latestReport = getLatestStrategy();
  const strategyConfig = latestReport?.strategy_json
    ? JSON.parse(latestReport.strategy_json)
    : config.strategy;

  const rawPrice = strategyConfig.priceRange || {};
  const priceFilter = { priceMin: rawPrice.min, priceMax: rawPrice.max };

  const collected = [];
  const seenShops = new Set();
  const genrePostCounts = new Map();

  function pushIfNew(p, tag) {
    const shopKey = (p.shop_display_name || p.shop_name || '').toLowerCase();
    if (!shopKey) return false;
    if (seenShops.has(shopKey)) return false;
    if (collected.find(x => x.id === p.id || x.item_url === p.item_url)) return false;
    seenShops.add(shopKey);
    collected.push({ ...p, strategy_tag: tag });
    return true;
  }

  // Phase 1: Reserved keyword slots
  const seasonalKws = tuning.seasonal?.keywords || [];
  const evergreenKws = tuning.evergreen?.keywords || [];
  const allReservedKws = [
    ...seasonalKws.map(k => ({ keyword: k, tag: 'seasonal' })),
    ...evergreenKws.map(k => ({ keyword: k, tag: 'evergreen' })),
  ];
  const reservedSlots = Math.min(2, toPost, allReservedKws.length);

  if (reservedSlots > 0) {
    const picked = allReservedKws.sort(() => Math.random() - 0.5).slice(0, reservedSlots);
    for (const { keyword, tag } of picked) {
      if (collected.length >= reservedSlots) break;
      try {
        const kwProducts = await searchProductsAPI(keyword, { maxResults: 5, maxPerShop: 1 });
        for (const p of kwProducts) {
          if (collected.length >= reservedSlots) break;
          pushIfNew(p, `${tag}:${keyword}`);
        }
      } catch (err) {
        console.error(`[get-products] ${tag} search failed "${keyword}": ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Phase 2: Genre slots
  const genreSlots = toPost - collected.length;
  if (genreSlots > 0) {
    const boostSet = new Set((tuning.genre?.boost || []).map(n => n.toLowerCase()));
    const reduceSet = new Set((tuning.genre?.reduce || []).map(n => n.toLowerCase()));

    const allGenres = getActiveGenres().map(g => {
      let weight = Math.min(g.score || 0.05, 0.15);
      const name = (g.genre_name || '').toLowerCase();
      if (boostSet.has(name)) weight *= 1.5;
      if (reduceSet.has(name)) weight *= 0.3;
      return { ...g, weight };
    });

    const pickedGenres = weightedSample(allGenres, genreSlots);

    for (const genre of pickedGenres) {
      if (collected.length >= toPost) break;

      let pool = getUnpostedProductsByGenre(genre.genre_id, 8, 1, priceFilter);
      if (pool.length === 0 && (priceFilter.priceMin || priceFilter.priceMax)) {
        const widened = {
          priceMin: priceFilter.priceMin ? Math.floor(priceFilter.priceMin * 0.5) : undefined,
          priceMax: priceFilter.priceMax ? Math.ceil(priceFilter.priceMax * 2) : undefined,
        };
        pool = getUnpostedProductsByGenre(genre.genre_id, 8, 1, widened);
      }
      if (pool.length === 0) {
        try {
          await fetchRanking({ genreId: genre.genre_id, maxResults: 15 });
          pool = getUnpostedProductsByGenre(genre.genre_id, 8, 1, priceFilter);
          if (pool.length === 0) pool = getUnpostedProductsByGenre(genre.genre_id, 8);
        } catch (err) {
          console.error(`[get-products] ranking fetch failed for ${genre.genre_name}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 1500));
      }

      for (const p of pool) {
        if (collected.length >= toPost) break;
        if (genrePostCounts.get(genre.genre_id) >= 1) break;
        const tag = `genre:${genre.genre_name}`;
        if (pushIfNew(p, tag)) {
          genrePostCounts.set(genre.genre_id, (genrePostCounts.get(genre.genre_id) || 0) + 1);
        }
      }
    }
  }

  // Phase 3: Fallback
  if (collected.length < toPost) {
    const fallback = getUnpostedProducts((toPost - collected.length) * 4);
    for (const p of fallback) {
      if (collected.length >= toPost) break;
      const gc = genrePostCounts.get(p.genre_id) || 0;
      if (gc >= 2) continue;
      if (pushIfNew(p, 'fallback')) {
        genrePostCounts.set(p.genre_id, gc + 1);
      }
    }
  }

  const out = collected.map(p => ({
    id: p.id,
    item_name: p.item_name,
    shop_name: p.shop_name,
    shop_display_name: p.shop_display_name,
    price: p.price,
    genre_id: p.genre_id,
    category: p.category,
    keyword_used: p.keyword_used,
    item_url: p.item_url,
    strategy_tag: p.strategy_tag,
    catchcopy: p.catchcopy || null,
    description: p.description ? p.description.substring(0, 200) : null,
    review_average: p.review_average || null,
    review_count: p.review_count || null,
  }));

  process.stdout.write(JSON.stringify({
    count: out.length,
    requested: toPost,
    todayCount,
    products: out,
  }, null, 2) + '\n');
}

main().catch(err => {
  console.error(`[get-products] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
