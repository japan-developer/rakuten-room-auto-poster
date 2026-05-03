import {
  getShopClicksForWeek,
  getOrdersForWeek,
  getRecentPosts,
  getActiveGenres,
  updateGenreScore,
  insertWeeklyReport,
  getPostClickAttribution,
} from './db.mjs';
import db from './db.mjs';
import { config } from './config.mjs';

export async function runWeeklyAnalysis(weekStart = getLastMonday()) {
  console.log(`[analyzer] Running analysis for week of ${weekStart}`);

  const posts = getRecentPosts(14);
  const shopClicks = getShopClicksForWeek(weekStart);
  const orders = getOrdersForWeek(weekStart);
  const genres = getActiveGenres();
  const postClicks = getPostClickAttribution(weekStart);

  console.log(`[analyzer] Data: ${posts.length} posts, ${shopClicks.length} shops, ${orders.length} orders, ${postClicks.length} attributed posts`);

  const genreClickScores = computeGenreClickScores(shopClicks, posts);
  const genreOrderScores = computeGenreOrderScores(orders, posts);
  const genrePostCounts = computeGenrePostCounts(posts, weekStart);

  for (const genre of genres) {
    const clickScore = genreClickScores[genre.genre_id] || 0;
    const orderScore = genreOrderScores[genre.genre_id] || 0;
    const postCount = genrePostCounts[genre.genre_id] || 0;

    const newScore = clamp(
      genre.score * 0.3 + orderScore * 0.5 + clickScore * 0.2,
      0.05, 0.99
    );

    updateGenreScore(genre.genre_id, newScore);
    console.log(`[analyzer]   ${genre.genre_name}: ${genre.score.toFixed(2)} → ${newScore.toFixed(2)} (clicks: ${clickScore.toFixed(2)}, orders: ${orderScore.toFixed(2)}, posts: ${postCount})`);
  }

  const priceAnalysis = analyzePriceRange(postClicks, orders);
  console.log(`[analyzer] Price: best range ¥${priceAnalysis.bestRange.min.toLocaleString()}〜¥${priceAnalysis.bestRange.max.toLocaleString()} (avg clicks: ${priceAnalysis.bestRange.avgClicks.toFixed(1)})`);

  const commentAnalysis = analyzeComments(postClicks);
  console.log(`[analyzer] Comment: best length ${commentAnalysis.bestLength.range} chars (avg clicks: ${commentAnalysis.bestLength.avgClicks.toFixed(1)})`);

  const timeAnalysis = analyzePostingTime(postClicks);
  console.log(`[analyzer] Time: best hour ${timeAnalysis.bestHour.hour}:00 (avg clicks: ${timeAnalysis.bestHour.avgClicks.toFixed(1)})`);

  const topPosts = postClicks.slice(0, 5);
  if (topPosts.length > 0 && topPosts[0].clicks > 0) {
    console.log(`[analyzer] Top posts by clicks:`);
    for (const p of topPosts) {
      console.log(`    ${p.clicks} clicks | ¥${p.price || '?'} | ${p.item_name?.substring(0, 40)} (${p.strategy_tag})`);
    }
  }

  const report = {
    weekStart,
    genreClickScores,
    genreOrderScores,
    genrePostCounts,
    priceAnalysis,
    commentAnalysis,
    timeAnalysis,
    orderCount: orders.length,
    totalCommission: orders.reduce((sum, o) => sum + (o.commission || 0), 0),
    postCount: posts.filter(p => p.posted_at >= weekStart).length,
  };

  const strategy = generateStrategy(report);

  insertWeeklyReport({
    week_start: weekStart,
    report_json: JSON.stringify(report),
    strategy_json: JSON.stringify(strategy),
  });

  console.log(`[analyzer] Strategy: exploit=${strategy.exploitRatio} explore=${strategy.exploreRatio} discover=${strategy.discoverRatio}`);
  console.log(`[analyzer] Commission: ¥${report.totalCommission.toLocaleString()}, Orders: ${report.orderCount}`);

  return { report, strategy };
}


function computeGenreClickScores(shopClicks, posts) {
  const scores = {};
  const shopClickMap = new Map();
  for (const sc of shopClicks) {
    shopClickMap.set(sc.shop_name, sc.total_clicks || sc.avg_clicks || 0);
  }

  const shopGenres = {};
  for (const post of posts) {
    const product = db.prepare('SELECT genre_id, shop_display_name FROM products WHERE id = ?').get(post.product_id);
    const genreId = product?.genre_id || 'all';
    for (const name of [post.shop_name, product?.shop_display_name].filter(Boolean)) {
      if (!shopGenres[name]) shopGenres[name] = new Set();
      shopGenres[name].add(genreId);
    }
  }

  const genreClicks = {};
  for (const [shopName, clickCount] of shopClickMap) {
    const genreSet = shopGenres[shopName];
    if (genreSet && genreSet.size > 0) {
      const perGenre = clickCount / genreSet.size;
      for (const genreId of genreSet) {
        genreClicks[genreId] = (genreClicks[genreId] || 0) + perGenre;
      }
    }
  }

  const maxClicks = Math.max(...Object.values(genreClicks), 1);
  for (const [genreId, clicks] of Object.entries(genreClicks)) {
    scores[genreId] = Math.min(clicks / maxClicks, 1);
  }
  return scores;
}

function computeGenreOrderScores(orders, posts) {
  const genreOrders = {};
  const genrePosts = {};

  for (const post of posts) {
    const product = db.prepare('SELECT genre_id FROM products WHERE id = ?').get(post.product_id);
    const genreId = product?.genre_id || 'all';
    genrePosts[genreId] = (genrePosts[genreId] || 0) + 1;
  }

  for (const order of orders) {
    const matchedPost = posts.find(p => p.shop_name === order.shop_name);
    if (matchedPost) {
      const product = db.prepare('SELECT genre_id FROM products WHERE id = ?').get(matchedPost.product_id);
      const genreId = product?.genre_id || 'all';
      genreOrders[genreId] = (genreOrders[genreId] || 0) + 1;
    }
  }

  const scores = {};
  for (const [genreId, postCount] of Object.entries(genrePosts)) {
    const orderCount = genreOrders[genreId] || 0;
    scores[genreId] = postCount > 0 ? Math.min(orderCount / postCount, 1) : 0;
  }
  return scores;
}

function computeGenrePostCounts(posts, weekStart) {
  const counts = {};
  for (const post of posts) {
    if (post.posted_at < weekStart) continue;
    const product = db.prepare('SELECT genre_id FROM products WHERE id = ?').get(post.product_id);
    const genreId = product?.genre_id || 'all';
    counts[genreId] = (counts[genreId] || 0) + 1;
  }
  return counts;
}

function analyzePriceRange(postClicks, orders) {
  const ranges = [
    { label: '〜1,000', min: 0, max: 1000 },
    { label: '1,001〜3,000', min: 1001, max: 3000 },
    { label: '3,001〜5,000', min: 3001, max: 5000 },
    { label: '5,001〜10,000', min: 5001, max: 10000 },
    { label: '10,001〜', min: 10001, max: 999999 },
  ];

  const rangeStats = ranges.map(r => {
    const postsInRange = postClicks.filter(p => p.price >= r.min && p.price <= r.max);
    const ordersInRange = orders.filter(o => o.price >= r.min && o.price <= r.max);
    const totalClicks = postsInRange.reduce((sum, p) => sum + p.clicks, 0);
    return {
      ...r,
      postCount: postsInRange.length,
      totalClicks,
      avgClicks: postsInRange.length > 0 ? totalClicks / postsInRange.length : 0,
      orderCount: ordersInRange.length,
    };
  });

  const qualified = rangeStats.filter(r => r.postCount >= 2);
  const bestRange = qualified.length > 0
    ? qualified.sort((a, b) => b.avgClicks - a.avgClicks)[0]
    : rangeStats[1];

  return { rangeStats, bestRange };
}

function analyzeComments(postClicks) {
  const lengthBuckets = [
    { range: '〜80', min: 0, max: 80 },
    { range: '81〜120', min: 81, max: 120 },
    { range: '121〜160', min: 121, max: 160 },
    { range: '161〜', min: 161, max: 9999 },
  ];

  const lengthStats = lengthBuckets.map(b => {
    const matching = postClicks.filter(p => {
      const len = (p.comment || '').length;
      return len >= b.min && len <= b.max;
    });
    const totalClicks = matching.reduce((sum, p) => sum + p.clicks, 0);
    return {
      ...b,
      postCount: matching.length,
      totalClicks,
      avgClicks: matching.length > 0 ? totalClicks / matching.length : 0,
    };
  });

  const withEmoji = postClicks.filter(p => /[\u{1F300}-\u{1FAFF}]/u.test(p.comment || ''));
  const withoutEmoji = postClicks.filter(p => !/[\u{1F300}-\u{1FAFF}]/u.test(p.comment || ''));
  const emojiAvgClicks = withEmoji.length > 0 ? withEmoji.reduce((s, p) => s + p.clicks, 0) / withEmoji.length : 0;
  const noEmojiAvgClicks = withoutEmoji.length > 0 ? withoutEmoji.reduce((s, p) => s + p.clicks, 0) / withoutEmoji.length : 0;

  const withPrice = postClicks.filter(p => /円|コスパ/.test(p.comment || ''));
  const withoutPrice = postClicks.filter(p => !/円|コスパ/.test(p.comment || ''));
  const priceAvgClicks = withPrice.length > 0 ? withPrice.reduce((s, p) => s + p.clicks, 0) / withPrice.length : 0;
  const noPriceAvgClicks = withoutPrice.length > 0 ? withoutPrice.reduce((s, p) => s + p.clicks, 0) / withoutPrice.length : 0;

  const qualified = lengthStats.filter(b => b.postCount >= 2);
  const bestLength = qualified.length > 0
    ? qualified.sort((a, b) => b.avgClicks - a.avgClicks)[0]
    : lengthStats[1];

  return {
    lengthStats,
    bestLength,
    emojiEffect: { with: emojiAvgClicks, without: noEmojiAvgClicks },
    priceEffect: { with: priceAvgClicks, without: noPriceAvgClicks },
  };
}

function analyzePostingTime(postClicks) {
  const hourStats = {};
  for (const p of postClicks) {
    const hour = new Date(p.posted_at).getUTCHours();
    const jstHour = (hour + 9) % 24;
    if (!hourStats[jstHour]) hourStats[jstHour] = { posts: 0, clicks: 0 };
    hourStats[jstHour].posts++;
    hourStats[jstHour].clicks += p.clicks;
  }

  const hourList = Object.entries(hourStats).map(([hour, stats]) => ({
    hour: parseInt(hour),
    postCount: stats.posts,
    totalClicks: stats.clicks,
    avgClicks: stats.posts > 0 ? stats.clicks / stats.posts : 0,
  })).sort((a, b) => b.avgClicks - a.avgClicks);

  const bestHour = hourList.find(h => h.postCount >= 2) || hourList[0] || { hour: 9, avgClicks: 0, postCount: 0 };

  return { hourStats: hourList, bestHour };
}

function generateStrategy(report) {
  const base = { ...config.strategy };

  if (report.orderCount === 0 && report.postCount > 10) {
    base.exploitRatio = 0.4;
    base.exploreRatio = 0.4;
    base.discoverRatio = 0.2;
  } else if (report.orderCount >= 5) {
    base.exploitRatio = 0.7;
    base.exploreRatio = 0.2;
    base.discoverRatio = 0.1;
  }

  const priceRange = {
    min: report.priceAnalysis.bestRange.min,
    max: report.priceAnalysis.bestRange.max,
  };

  const commentRec = {
    targetLength: report.commentAnalysis.bestLength.range,
    useEmoji: report.commentAnalysis.emojiEffect.with >= report.commentAnalysis.emojiEffect.without,
    mentionPrice: report.commentAnalysis.priceEffect.with >= report.commentAnalysis.priceEffect.without,
  };

  const bestPostHour = report.timeAnalysis.bestHour.hour;

  return {
    ...base,
    weekStart: report.weekStart,
    priceRange,
    commentRec,
    bestPostHour,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getLastMonday() {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  now.setDate(now.getDate() - diff);
  return now.toISOString().split('T')[0];
}

if (process.argv[1] && process.argv[1].includes('analyzer')) {
  runWeeklyAnalysis().catch(console.error);
}
