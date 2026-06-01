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
  getPostedItemCodes,
  extractItemCode,
} from '../src/db.mjs';
import { fetchRanking } from '../src/searcher.mjs';

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
  const reviewFilter = tuning.productFilter || {};
  const productFilter = {
    priceMin: rawPrice.min,
    priceMax: rawPrice.max,
    minReviewCount: reviewFilter.minReviewCount,
    minReviewAverage: reviewFilter.minReviewAverage,
  };

  const collected = [];
  const seenShops = new Set();
  const seenItemCodes = new Set();
  const genrePostCounts = new Map();
  const excludedGenres = new Set(config.excludedGenreIds || []);
  // ROOM側で「すでにコレ！」判定される商品の予防除外
  const blockedItemCodes = getPostedItemCodes();

  function filterPool(pool) {
    // SQL の posted=0 を満たしていても、同 ROOM itemcode が投稿済のものは弾く
    return pool.filter(p => {
      const code = extractItemCode(p.item_url);
      return !code || !blockedItemCodes.has(code);
    });
  }

  function pushIfNew(p, tag) {
    if (p.genre_id && excludedGenres.has(p.genre_id)) return false;
    const shopKey = (p.shop_display_name || p.shop_name || '').toLowerCase();
    if (!shopKey) return false;
    if (seenShops.has(shopKey)) return false;
    if (collected.find(x => x.id === p.id || x.item_url === p.item_url)) return false;
    const code = extractItemCode(p.item_url);
    if (code) {
      if (blockedItemCodes.has(code)) return false;
      if (seenItemCodes.has(code)) return false;
      seenItemCodes.add(code);
    }
    seenShops.add(shopKey);
    collected.push({ ...p, strategy_tag: tag });
    return true;
  }

  // 商品発見は collect-products ジョブ (JST 06:00) に分離済み。
  // 投稿時は DB の既存在庫から選定するのみ。
  // Phase 2: Genre slots
  const genreSlots = toPost;
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

      let pool = filterPool(getUnpostedProductsByGenre(genre.genre_id, 8, 1, productFilter));
      // Widen 1: relax price band (keep review filter)
      if (pool.length === 0 && (productFilter.priceMin || productFilter.priceMax)) {
        const widened = {
          ...productFilter,
          priceMin: productFilter.priceMin ? Math.floor(productFilter.priceMin * 0.5) : undefined,
          priceMax: productFilter.priceMax ? Math.ceil(productFilter.priceMax * 2) : undefined,
        };
        pool = filterPool(getUnpostedProductsByGenre(genre.genre_id, 8, 1, widened));
      }
      // Widen 2: drop review filter (keep price band)
      if (pool.length === 0 && (productFilter.minReviewCount || productFilter.minReviewAverage)) {
        pool = filterPool(getUnpostedProductsByGenre(genre.genre_id, 8, 1, {
          priceMin: productFilter.priceMin,
          priceMax: productFilter.priceMax,
        }));
      }
      if (pool.length === 0) {
        try {
          await fetchRanking({ genreId: genre.genre_id, maxResults: 15 });
          pool = filterPool(getUnpostedProductsByGenre(genre.genre_id, 8, 1, productFilter));
          if (pool.length === 0) pool = filterPool(getUnpostedProductsByGenre(genre.genre_id, 8));
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
    const fallback = filterPool(getUnpostedProducts((toPost - collected.length) * 4));
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
