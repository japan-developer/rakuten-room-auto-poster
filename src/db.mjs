import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config.mjs';

// Ensure data directory exists
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_url TEXT UNIQUE NOT NULL,
    item_name TEXT NOT NULL,
    shop_name TEXT,
    price INTEGER,
    keyword_used TEXT,
    category TEXT,
    image_url TEXT,
    discovered_at TEXT DEFAULT (datetime('now')),
    posted INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    room_post_url TEXT,
    comment TEXT,
    hashtags TEXT,
    strategy_tag TEXT,
    posted_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shop_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_name TEXT NOT NULL,
    date TEXT NOT NULL,
    clicks INTEGER DEFAULT 0,
    UNIQUE(shop_name, date)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_name TEXT,
    shop_name TEXT,
    order_date TEXT,
    price INTEGER,
    commission INTEGER,
    keyword_guess TEXT,
    collected_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS weekly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL UNIQUE,
    report_json TEXT,
    strategy_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS keyword_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT UNIQUE NOT NULL,
    category TEXT,
    score REAL DEFAULT 0.5,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    last_used TEXT
  );

  CREATE TABLE IF NOT EXISTS genre_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    genre_id TEXT UNIQUE NOT NULL,
    genre_name TEXT NOT NULL,
    score REAL DEFAULT 0.5,
    active INTEGER DEFAULT 1,
    last_fetched TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- Migrations ---
try { db.exec(`ALTER TABLE products ADD COLUMN genre_id TEXT DEFAULT 'all'`); } catch {}
try { db.exec(`ALTER TABLE products ADD COLUMN shop_display_name TEXT`); } catch {}
try { db.exec(`ALTER TABLE products ADD COLUMN catchcopy TEXT`); } catch {}
try { db.exec(`ALTER TABLE products ADD COLUMN description TEXT`); } catch {}
try { db.exec(`ALTER TABLE products ADD COLUMN review_average REAL`); } catch {}
try { db.exec(`ALTER TABLE products ADD COLUMN review_count INTEGER`); } catch {}

// --- Data Access ---

// Products
export function upsertProduct({ item_url, item_name, shop_name, shop_display_name, price, keyword_used, category, image_url, genre_id, catchcopy, description, review_average, review_count }) {
  return db.prepare(`
    INSERT INTO products (item_url, item_name, shop_name, shop_display_name, price, keyword_used, category, image_url, genre_id, catchcopy, description, review_average, review_count)
    VALUES (@item_url, @item_name, @shop_name, @shop_display_name, @price, @keyword_used, @category, @image_url, @genre_id, @catchcopy, @description, @review_average, @review_count)
    ON CONFLICT(item_url) DO UPDATE SET
      item_name = excluded.item_name,
      shop_display_name = COALESCE(excluded.shop_display_name, products.shop_display_name),
      price = excluded.price,
      image_url = excluded.image_url,
      genre_id = excluded.genre_id,
      catchcopy = COALESCE(excluded.catchcopy, products.catchcopy),
      description = COALESCE(excluded.description, products.description),
      review_average = COALESCE(excluded.review_average, products.review_average),
      review_count = COALESCE(excluded.review_count, products.review_count)
  `).run({ item_url, item_name, shop_name, shop_display_name: shop_display_name || null, price, keyword_used, category, image_url, genre_id: genre_id || 'all', catchcopy: catchcopy || null, description: description || null, review_average: review_average || null, review_count: review_count || null });
}

export function getUnpostedProducts(limit = 10, maxPerShop = 1) {
  return db.prepare(`
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY shop_name ORDER BY discovered_at DESC) AS rn
      FROM products
      WHERE posted = 0
        AND shop_name NOT LIKE '%kobo%'
        AND shop_name NOT LIKE '%ebook%'
        AND shop_name != 'book'
        AND shop_name NOT IN (
          SELECT DISTINCT pr.shop_name
          FROM posts p JOIN products pr ON p.product_id = pr.id
          WHERE date(p.posted_at) = date('now')
        )
    ) WHERE rn <= ?
    ORDER BY discovered_at DESC
    LIMIT ?
  `).all(maxPerShop, limit);
}

export function markProductPosted(productId) {
  return db.prepare(`UPDATE products SET posted = 1 WHERE id = ?`).run(productId);
}

// Posts
export function insertPost({ product_id, room_post_url, comment, hashtags, strategy_tag }) {
  return db.prepare(`
    INSERT INTO posts (product_id, room_post_url, comment, hashtags, strategy_tag)
    VALUES (@product_id, @room_post_url, @comment, @hashtags, @strategy_tag)
  `).run({ product_id, room_post_url, comment, hashtags, strategy_tag });
}

export function getRecentPosts(days = 7) {
  return db.prepare(`
    SELECT p.*, pr.item_name, pr.shop_name, pr.shop_display_name, pr.keyword_used
    FROM posts p JOIN products pr ON p.product_id = pr.id
    WHERE p.posted_at >= datetime('now', ?)
    ORDER BY p.posted_at DESC
  `).all(`-${days} days`);
}

export function getTodayPostCount() {
  return db.prepare(`
    SELECT COUNT(*) as count FROM posts WHERE date(posted_at) = date('now')
  `).get().count;
}

// Shop Clicks
export function upsertShopClicks({ shop_name, date, clicks }) {
  return db.prepare(`
    INSERT INTO shop_clicks (shop_name, date, clicks)
    VALUES (@shop_name, @date, @clicks)
    ON CONFLICT(shop_name, date) DO UPDATE SET clicks = excluded.clicks
  `).run({ shop_name, date, clicks });
}

export function getShopClicksForWeek(weekStart) {
  return db.prepare(`
    SELECT shop_name, SUM(clicks) as total_clicks, AVG(clicks) as avg_clicks
    FROM shop_clicks
    WHERE date >= ? AND date < date(?, '+7 days')
    GROUP BY shop_name ORDER BY total_clicks DESC
  `).all(weekStart, weekStart);
}

export function getPostClickAttribution(weekStart) {
  return db.prepare(`
    SELECT
      p.id as post_id,
      p.posted_at,
      p.comment,
      p.strategy_tag,
      pr.item_name,
      pr.shop_name,
      pr.shop_display_name,
      pr.price,
      pr.genre_id,
      COALESCE(sc.clicks, 0) as clicks
    FROM posts p
    JOIN products pr ON p.product_id = pr.id
    LEFT JOIN shop_clicks sc ON (
      pr.shop_display_name = sc.shop_name OR pr.shop_name = sc.shop_name
    ) AND date(p.posted_at) = sc.date
    WHERE p.posted_at >= ? AND p.posted_at < date(?, '+7 days')
    ORDER BY clicks DESC
  `).all(weekStart, weekStart);
}

// Orders
export function insertOrder({ product_name, shop_name, order_date, price, commission, keyword_guess }) {
  return db.prepare(`
    INSERT INTO orders (product_name, shop_name, order_date, price, commission, keyword_guess)
    VALUES (@product_name, @shop_name, @order_date, @price, @commission, @keyword_guess)
  `).run({ product_name, shop_name, order_date, price, commission, keyword_guess });
}

export function getOrdersForWeek(weekStart) {
  return db.prepare(`
    SELECT * FROM orders
    WHERE order_date >= ? AND order_date < date(?, '+7 days')
    ORDER BY order_date DESC
  `).all(weekStart, weekStart);
}

// Weekly Reports
export function insertWeeklyReport({ week_start, report_json, strategy_json }) {
  return db.prepare(`
    INSERT INTO weekly_reports (week_start, report_json, strategy_json)
    VALUES (@week_start, @report_json, @strategy_json)
    ON CONFLICT(week_start) DO UPDATE SET
      report_json = excluded.report_json,
      strategy_json = excluded.strategy_json
  `).run({ week_start, report_json, strategy_json });
}

export function getLatestStrategy() {
  return db.prepare(`
    SELECT * FROM weekly_reports ORDER BY week_start DESC LIMIT 1
  `).get();
}

// Keyword Pool
export function upsertKeyword({ keyword, category, score, active }) {
  return db.prepare(`
    INSERT INTO keyword_pool (keyword, category, score, active)
    VALUES (@keyword, @category, @score, @active)
    ON CONFLICT(keyword) DO UPDATE SET
      category = COALESCE(excluded.category, keyword_pool.category),
      score = excluded.score,
      active = excluded.active
  `).run({ keyword, category, score: score ?? 0.5, active: active ?? 1 });
}

export function getActiveKeywords() {
  return db.prepare(`
    SELECT * FROM keyword_pool WHERE active = 1 ORDER BY score DESC
  `).all();
}

export function getKeywordsByStrategy({ exploitRatio, exploreRatio, discoverRatio }, count) {
  const exploitCount = Math.round(count * exploitRatio);
  const exploreCount = Math.round(count * exploreRatio);
  const discoverCount = count - exploitCount - exploreCount;

  const exploit = db.prepare(`
    SELECT *, 'exploit' as strategy_tag FROM keyword_pool
    WHERE active = 1 AND score >= 0.6
    ORDER BY score DESC LIMIT ?
  `).all(exploitCount);

  const explore = db.prepare(`
    SELECT *, 'explore' as strategy_tag FROM keyword_pool
    WHERE active = 1 AND score >= 0.3 AND score < 0.6
    ORDER BY RANDOM() LIMIT ?
  `).all(exploreCount);

  const discover = db.prepare(`
    SELECT *, 'discover' as strategy_tag FROM keyword_pool
    WHERE active = 1 AND (last_used IS NULL OR last_used < datetime('now', '-14 days'))
    ORDER BY RANDOM() LIMIT ?
  `).all(discoverCount);

  return [...exploit, ...explore, ...discover];
}

export function updateKeywordScore(keyword, score) {
  return db.prepare(`
    UPDATE keyword_pool SET score = ?, last_used = datetime('now') WHERE keyword = ?
  `).run(score, keyword);
}

// Genre Pool
export function upsertGenre({ genre_id, genre_name, score, active }) {
  return db.prepare(`
    INSERT INTO genre_pool (genre_id, genre_name, score, active)
    VALUES (@genre_id, @genre_name, @score, @active)
    ON CONFLICT(genre_id) DO UPDATE SET
      genre_name = excluded.genre_name,
      score = COALESCE(excluded.score, genre_pool.score),
      active = excluded.active
  `).run({ genre_id, genre_name, score: score ?? 0.5, active: active ?? 1 });
}

export function getActiveGenres() {
  return db.prepare(`
    SELECT * FROM genre_pool WHERE active = 1 ORDER BY score DESC
  `).all();
}

export function getGenresByStrategy({ exploitRatio, exploreRatio, discoverRatio }, count) {
  const exploitCount = Math.max(1, Math.round(count * exploitRatio));
  const exploreCount = Math.max(1, Math.round(count * exploreRatio));
  const discoverCount = Math.max(1, count - exploitCount - exploreCount);

  const exploit = db.prepare(`
    SELECT *, 'exploit' as strategy_tag FROM genre_pool
    WHERE active = 1 AND score >= 0.6
    ORDER BY score DESC LIMIT ?
  `).all(exploitCount);

  const explore = db.prepare(`
    SELECT *, 'explore' as strategy_tag FROM genre_pool
    WHERE active = 1 AND score >= 0.3 AND score < 0.6
    ORDER BY RANDOM() LIMIT ?
  `).all(exploreCount);

  const discover = db.prepare(`
    SELECT *, 'discover' as strategy_tag FROM genre_pool
    WHERE active = 1 AND (last_fetched IS NULL OR last_fetched < datetime('now', '-14 days'))
    ORDER BY RANDOM() LIMIT ?
  `).all(discoverCount);

  const result = [...exploit, ...explore, ...discover];
  if (result.length < count) {
    const fallback = db.prepare(`
      SELECT *, 'explore' as strategy_tag FROM genre_pool
      WHERE active = 1 AND genre_id NOT IN (${result.map(() => '?').join(',')})
      ORDER BY RANDOM() LIMIT ?
    `).all(...result.map(r => r.genre_id), count - result.length);
    result.push(...fallback);
  }

  return result;
}

export function updateGenreScore(genreId, score) {
  return db.prepare(`
    UPDATE genre_pool SET score = ? WHERE genre_id = ?
  `).run(score, genreId);
}

export function markGenreFetched(genreId) {
  return db.prepare(`
    UPDATE genre_pool SET last_fetched = datetime('now') WHERE genre_id = ?
  `).run(genreId);
}

export function getUnpostedProductsByGenre(genreId, limit = 10, maxPerShop = 1, { priceMin, priceMax } = {}) {
  let priceFilter = '';
  const params = [genreId];
  if (priceMin != null) {
    priceFilter += ' AND price >= ?';
    params.push(priceMin);
  }
  if (priceMax != null) {
    priceFilter += ' AND price <= ?';
    params.push(priceMax);
  }
  params.push(maxPerShop, limit);

  return db.prepare(`
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY shop_name ORDER BY discovered_at DESC) AS rn
      FROM products
      WHERE posted = 0
        AND genre_id = ?
        AND shop_name NOT LIKE '%kobo%'
        AND shop_name NOT LIKE '%ebook%'
        AND shop_name != 'book'
        ${priceFilter}
        AND shop_name NOT IN (
          SELECT DISTINCT pr.shop_name
          FROM posts p JOIN products pr ON p.product_id = pr.id
          WHERE date(p.posted_at) = date('now')
        )
    ) WHERE rn <= ?
    ORDER BY discovered_at DESC
    LIMIT ?
  `).all(...params);
}

// Stats
export function getStats() {
  const products = db.prepare(`SELECT COUNT(*) as count FROM products`).get().count;
  const posted = db.prepare(`SELECT COUNT(*) as count FROM products WHERE posted = 1`).get().count;
  const posts = db.prepare(`SELECT COUNT(*) as count FROM posts`).get().count;
  const todayPosts = getTodayPostCount();
  const keywords = db.prepare(`SELECT COUNT(*) as count FROM keyword_pool WHERE active = 1`).get().count;
  const genres = db.prepare(`SELECT COUNT(*) as count FROM genre_pool WHERE active = 1`).get().count;
  const orders = db.prepare(`SELECT COUNT(*) as count FROM orders`).get().count;
  const latestStrategy = getLatestStrategy();

  return { products, posted, posts, todayPosts, keywords, genres, orders, latestStrategy };
}

export default db;
