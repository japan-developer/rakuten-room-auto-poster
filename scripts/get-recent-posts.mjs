#!/usr/bin/env node
import { getRecentPosts, getPostClickAttribution } from '../src/db.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--days');
const days = i >= 0 ? parseInt(args[i + 1], 10) : 14;

const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

const posts = getRecentPosts(days);
const attribution = getPostClickAttribution(since);

process.stdout.write(JSON.stringify({
  days,
  since,
  postCount: posts.length,
  posts: posts.map(p => ({
    id: p.id,
    posted_at: p.posted_at,
    item_name: p.item_name,
    shop_name: p.shop_name,
    shop_display_name: p.shop_display_name,
    comment: p.comment,
    hashtags: p.hashtags,
    strategy_tag: p.strategy_tag,
  })),
  attribution: attribution.map(a => ({
    post_id: a.post_id,
    posted_at: a.posted_at,
    item_name: a.item_name,
    shop: a.shop_display_name || a.shop_name,
    price: a.price,
    genre_id: a.genre_id,
    strategy_tag: a.strategy_tag,
    clicks: a.clicks,
    comment_len: (a.comment || '').length,
  })),
}, null, 2) + '\n');
