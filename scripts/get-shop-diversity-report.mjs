#!/usr/bin/env node
import db from '../src/db.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--days');
const days = i >= 0 ? parseInt(args[i + 1], 10) : 7;

const rows = db.prepare(`
  SELECT
    date(p.posted_at) AS day,
    COALESCE(pr.shop_display_name, pr.shop_name) AS shop,
    COUNT(*) AS posts
  FROM posts p
  JOIN products pr ON p.product_id = pr.id
  WHERE p.posted_at >= datetime('now', ?)
  GROUP BY day, shop
  ORDER BY day DESC, posts DESC
`).all(`-${days} days`);

const byDay = {};
for (const r of rows) {
  if (!byDay[r.day]) byDay[r.day] = { day: r.day, totalPosts: 0, uniqueShops: 0, duplicates: [] };
  byDay[r.day].totalPosts += r.posts;
  byDay[r.day].uniqueShops += 1;
  if (r.posts > 1) byDay[r.day].duplicates.push({ shop: r.shop, posts: r.posts });
}

const summary = Object.values(byDay).sort((a, b) => b.day.localeCompare(a.day));
const violations = summary.filter(d => d.duplicates.length > 0);

const shopTotals = {};
for (const r of rows) shopTotals[r.shop] = (shopTotals[r.shop] || 0) + r.posts;
const topShops = Object.entries(shopTotals)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)
  .map(([shop, posts]) => ({ shop, posts }));

process.stdout.write(JSON.stringify({
  days,
  daySummary: summary,
  violations,
  topShops,
  diversityHealthy: violations.length === 0,
}, null, 2) + '\n');
