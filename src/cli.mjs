#!/usr/bin/env node
import { config } from './config.mjs';
import {
  getStats,
  getRecentPosts,
  getActiveKeywords,
  getActiveGenres,
  upsertKeyword,
  upsertGenre,
  getLatestStrategy,
} from './db.mjs';
import { searchProducts, fetchRanking } from './searcher.mjs';
import { collectReports } from './collector.mjs';
import { runWeeklyAnalysis } from './analyzer.mjs';
import { startScheduler } from './scheduler.mjs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function spawnAgent(role, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/agent.mjs', role, ...extraArgs], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`agent ${role} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

const [command, ...args] = process.argv.slice(2);

const commands = {
  search: cmdSearch,
  ranking: cmdRanking,
  post: cmdPost,
  collect: cmdCollect,
  engage: cmdEngage,
  analyze: cmdAnalyze,
  status: cmdStatus,
  'init-keywords': cmdInitKeywords,
  'init-genres': cmdInitGenres,
  scheduler: cmdScheduler,
  help: cmdHelp,
};

async function main() {
  if (!command || !commands[command]) {
    cmdHelp();
    process.exit(command ? 1 : 0);
  }

  try {
    await commands[command]();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function cmdSearch() {
  const keyword = args[0];
  if (!keyword) {
    console.error('Usage: node src/cli.mjs search <keyword>');
    process.exit(1);
  }
  const products = await searchProducts(keyword);
  console.log(`\nFound ${products.length} products for "${keyword}"`);
  for (const p of products.slice(0, 10)) {
    console.log(`  ${p.item_name.substring(0, 60)} — ¥${p.price?.toLocaleString() || '?'} (${p.shop_name})`);
  }
}

async function cmdRanking() {
  const genreId = args[0] || undefined;
  const products = await fetchRanking({ genreId });
  console.log(`\nRanking: ${products.length} trending products`);
  for (const p of products.slice(0, 15)) {
    console.log(`  ${p.item_name.substring(0, 55)} — ¥${p.price?.toLocaleString() || '?'} (${p.shop_name})`);
  }
}

async function cmdPost() {
  const countIdx = args.indexOf('--count');
  const count = countIdx >= 0 ? parseInt(args[countIdx + 1], 10) : 7;

  if (!config.email || !config.password) {
    console.error('Error: RAKUTEN_EMAIL and RAKUTEN_PASSWORD must be set in .env');
    process.exit(1);
  }

  await spawnAgent('post', ['--count', String(count)]);
}

async function cmdCollect() {
  if (!config.email || !config.password) {
    console.error('Error: RAKUTEN_EMAIL and RAKUTEN_PASSWORD must be set in .env');
    process.exit(1);
  }

  const screenshotOnly = args.includes('--screenshot-only');
  const result = await collectReports({ screenshotOnly });
  console.log(`\nCollected: ${result.clicks.count} click records, ${result.orders.count} order records`);
}

async function cmdEngage() {
  if (!config.email || !config.password) {
    console.error('Error: RAKUTEN_EMAIL and RAKUTEN_PASSWORD must be set in .env');
    process.exit(1);
  }
  const { spawn } = await import('child_process');
  await new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/engage.mjs'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`engage exited ${code}`)));
    child.on('error', reject);
  });
}

async function cmdAnalyze() {
  const result = await runWeeklyAnalysis();
  console.log('\n--- Weekly Strategy ---');
  console.log(JSON.stringify(result.strategy, null, 2));

  console.log('\n[cli] Spawning review agent...');
  await spawnAgent('review');
}

async function cmdStatus() {
  const stats = getStats();
  const recentPosts = getRecentPosts(1);
  const keywords = getActiveKeywords();

  console.log('=== Rakuten ROOM Auto-Poster Status ===\n');
  console.log(`Products:    ${stats.products} total, ${stats.posted} posted`);
  console.log(`Posts:       ${stats.posts} total, ${stats.todayPosts} today`);
  console.log(`Keywords:    ${stats.keywords} active`);
  console.log(`Orders:      ${stats.orders} recorded`);

  if (stats.latestStrategy) {
    const strategy = JSON.parse(stats.latestStrategy.strategy_json);
    console.log(`\nLatest Strategy (${stats.latestStrategy.week_start}):`);
    console.log(`  Exploit: ${(strategy.exploitRatio * 100).toFixed(0)}%`);
    console.log(`  Explore: ${(strategy.exploreRatio * 100).toFixed(0)}%`);
    console.log(`  Discover: ${(strategy.discoverRatio * 100).toFixed(0)}%`);
  }

  if (recentPosts.length > 0) {
    console.log('\nRecent posts (last 24h):');
    for (const p of recentPosts.slice(0, 5)) {
      console.log(`  [${p.posted_at}] ${p.item_name?.substring(0, 50)} (${p.strategy_tag})`);
    }
  }

  if (keywords.length > 0) {
    console.log(`\nTop keywords (by score):`);
    for (const kw of keywords.slice(0, 10)) {
      console.log(`  ${kw.keyword} — score: ${kw.score.toFixed(2)} (${kw.category || '-'})`);
    }
  }

  const genres = getActiveGenres();
  if (genres.length > 0) {
    console.log(`\nGenres (by score):`);
    for (const g of genres) {
      console.log(`  [${g.genre_id}] ${g.genre_name} — score: ${g.score.toFixed(2)}${g.last_fetched ? ` (last: ${g.last_fetched})` : ''}`);
    }
  }
}

async function cmdInitKeywords() {
  const defaultKeywords = [
    { keyword: 'ワイヤレスイヤホン', category: '家電' },
    { keyword: 'スマホケース', category: 'スマホアクセサリ' },
    { keyword: 'プロテイン', category: '健康食品' },
    { keyword: 'メンズ 財布', category: 'ファッション' },
    { keyword: 'レディース バッグ', category: 'ファッション' },
    { keyword: 'キッチン 便利グッズ', category: 'キッチン' },
    { keyword: '防災グッズ', category: '生活用品' },
    { keyword: 'コスメ 韓国', category: 'コスメ' },
    { keyword: 'ベビー用品', category: 'ベビー・キッズ' },
    { keyword: 'ペット おやつ', category: 'ペット' },
    { keyword: 'ゲーミング マウス', category: '家電' },
    { keyword: 'ルームウェア', category: 'ファッション' },
    { keyword: '入浴剤', category: '日用品' },
    { keyword: 'ふるさと納税 食品', category: 'ふるさと納税' },
    { keyword: 'キャンプ用品', category: 'アウトドア' },
    { keyword: 'ダイエット サプリ', category: '健康食品' },
    { keyword: 'お取り寄せ スイーツ', category: '食品' },
    { keyword: '知育玩具', category: 'ベビー・キッズ' },
    { keyword: '収納 ボックス', category: '生活用品' },
    { keyword: 'ランニングシューズ', category: 'スポーツ' },
  ];

  let added = 0;
  for (const kw of defaultKeywords) {
    const result = upsertKeyword({ ...kw, score: 0.5, active: 1 });
    if (result.changes > 0) added++;
  }

  console.log(`Initialized keyword pool: ${added} keywords added/updated (total: ${defaultKeywords.length})`);
}

async function cmdInitGenres() {
  let added = 0;
  for (const g of config.genres) {
    const result = upsertGenre({ genre_id: g.id, genre_name: g.name, score: 0.5, active: 1 });
    if (result.changes > 0) added++;
  }

  console.log(`Initialized genre pool: ${added} genres added/updated (total: ${config.genres.length})`);
}

function cmdScheduler() {
  startScheduler();
}

function cmdHelp() {
  console.log(`
Rakuten ROOM Auto-Poster (Template)

Usage: node src/cli.mjs <command> [options]

Commands:
  search <keyword>          Search Rakuten for products (API)
  ranking [genreId]         Fetch trending products from ranking
  post [--count N]          Post products to ROOM
  collect                   Collect affiliate report data
  engage                    Run engagement (likes + follows)
  analyze                   Run weekly analysis + improvement
  status                    Show current status & stats
  init-keywords             Initialize keyword pool
  init-genres               Initialize genre pool
  scheduler                 Start automated scheduler daemon
  help                      Show this help
`);
}

main();
