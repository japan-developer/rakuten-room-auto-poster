#!/usr/bin/env node
/**
 * The only Playwright entry point for the post agent.
 *
 * Reads a batch JSON file: { items: [{ product_id, comment, hashtags }] }
 * Opens a single browser session, posts each item via postToRoom() in
 * order, records DB rows incrementally, and prints a JSON summary.
 */
import fs from 'fs';
import { launchAuthenticated } from '../src/auth.mjs';
import { postToRoom } from '../src/poster.mjs';
import { config } from '../src/config.mjs';
import db, {
  insertPost,
  markProductPosted,
  getTodayPostCount,
} from '../src/db.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { file: null, stdin: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') out.file = args[++i];
    else if (args[i] === '--stdin') out.stdin = true;
    else if (args[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

async function readBatch(opts) {
  if (opts.stdin) {
    return new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', c => buf += c);
      process.stdin.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      process.stdin.on('error', reject);
    });
  }
  if (!opts.file) throw new Error('Provide --file <path> or --stdin');
  return JSON.parse(fs.readFileSync(opts.file, 'utf-8'));
}

function getProductById(id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

async function randomDelay(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  console.error(`[post-batch] waiting ${Math.round(ms / 1000)}s...`);
  await new Promise(r => setTimeout(r, ms));
}

async function main() {
  const opts = parseArgs();
  const batch = await readBatch(opts);
  const items = batch.items || batch;
  if (!Array.isArray(items) || items.length === 0) {
    console.error('[post-batch] empty batch');
    process.exit(2);
  }

  const todayCount = getTodayPostCount();
  const remaining = Math.max(0, config.posting.dailyLimit - todayCount);
  if (remaining === 0) {
    process.stdout.write(JSON.stringify({ posted: 0, failed: 0, reason: 'daily_limit' }) + '\n');
    return;
  }
  const slice = items.slice(0, remaining);

  const results = [];
  let posted = 0;
  let failed = 0;

  if (opts.dryRun) {
    for (const item of slice) {
      const p = getProductById(item.product_id);
      results.push({ product_id: item.product_id, ok: true, dryRun: true, item: p?.item_name?.slice(0, 50) });
    }
    process.stdout.write(JSON.stringify({ posted: 0, failed: 0, dryRun: true, results }) + '\n');
    return;
  }

  console.error(`[post-batch] launching browser for ${slice.length} items`);
  const { browser, page } = await launchAuthenticated();
  try {
    for (let i = 0; i < slice.length; i++) {
      const item = slice[i];
      const product = getProductById(item.product_id);
      if (!product) {
        failed++;
        results.push({ product_id: item.product_id, ok: false, error: 'product_not_found' });
        continue;
      }
      try {
        console.error(`[post-batch] (${i + 1}/${slice.length}) ${product.item_name.slice(0, 50)}`);
        const roomUrl = await postToRoom(page, product, item.comment, item.hashtags);
        markProductPosted(product.id);
        insertPost({
          product_id: product.id,
          room_post_url: roomUrl,
          comment: item.comment,
          hashtags: item.hashtags,
          strategy_tag: item.strategy_tag || product.strategy_tag || 'agent',
        });
        posted++;
        results.push({ product_id: product.id, ok: true, room_url: roomUrl });
      } catch (err) {
        failed++;
        console.error(`[post-batch] failed: ${err.message}`);
        results.push({ product_id: product.id, ok: false, error: err.message });
        if (err.message.includes('重複操作') || err.message.includes('R200')) {
          try { markProductPosted(product.id); } catch {}
        }
        try { await page.waitForTimeout(5000); } catch {}
      }

      if (i < slice.length - 1) {
        await randomDelay(config.posting.minInterval, config.posting.maxInterval);
      }
    }
  } finally {
    try { await browser.close(); } catch {}
  }

  process.stdout.write(JSON.stringify({ posted, failed, results }) + '\n');
  if (posted === 0) process.exit(1);
}

main().catch(err => {
  console.error(`[post-batch] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
