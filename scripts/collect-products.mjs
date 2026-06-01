#!/usr/bin/env node
/**
 * Dedicated product discovery job.
 *
 * Sweeps the rotating keyword pool with 4 sort orders to surface diverse
 * inventory (popular / new arrivals / cheapest / high commission).
 *
 * Runs daily at JST 06:00 via the launchd scheduler. Decouples discovery
 * from posting — get-products.mjs now only SELECTS from existing inventory.
 *
 * Output (stdout, single line JSON):
 *   { elapsed_sec, total_calls, total_upserts, dedup_rate, keywords: [...] }
 */
import { searchProductsAPI } from '../src/searcher.mjs';
import {
  getKeywordsForCollect,
  updateKeywordLastUsed,
  getStats,
} from '../src/db.mjs';

const SORTS = ['-reviewCount', '-updateTimestamp', '+itemPrice', '-affiliateRate'];
const KEYWORDS_PER_RUN = 5;
const MAX_RESULTS_PER_CALL = 10;
const SLEEP_MS = 1100;

async function main() {
  const t0 = Date.now();

  const productsBefore = getStats().products;

  const keywords = getKeywordsForCollect(KEYWORDS_PER_RUN);
  if (keywords.length === 0) {
    console.error('[collect-products] no active keywords in pool');
    process.stdout.write(JSON.stringify({ error: 'empty_keyword_pool' }) + '\n');
    process.exit(1);
  }
  console.error(`[collect-products] picked ${keywords.length} keywords: ${keywords.map(k => k.keyword).join(', ')}`);

  let totalCalls = 0;
  let totalUpserts = 0;
  const perKw = [];

  for (const kw of keywords) {
    let kwUpserts = 0;
    for (const sort of SORTS) {
      try {
        const products = await searchProductsAPI(kw.keyword, {
          maxResults: MAX_RESULTS_PER_CALL,
          maxPerShop: 1,
          sort,
        });
        kwUpserts += products.length;
        totalUpserts += products.length;
        totalCalls += 1;
      } catch (err) {
        console.error(`[collect-products] failed kw="${kw.keyword}" sort=${sort}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, SLEEP_MS));
    }
    updateKeywordLastUsed(kw.id);
    perKw.push({ keyword: kw.keyword, upserts: kwUpserts });
  }

  const netNew = getStats().products - productsBefore;

  const summary = {
    elapsed_sec: Math.round((Date.now() - t0) / 1000),
    keywords_used: keywords.length,
    total_calls: totalCalls,
    total_upserts: totalUpserts,
    net_new: netNew,
    dedup_rate: totalUpserts > 0 ? +((1 - netNew / totalUpserts) * 100).toFixed(1) : null,
    per_keyword: perKw,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch(err => {
  console.error(`[collect-products] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
