import { chromium } from 'playwright';
import { config } from './config.mjs';
import { upsertProduct, markGenreFetched } from './db.mjs';

function apiParams() {
  return new URLSearchParams({
    applicationId: config.rakutenAppId,
    accessKey: config.rakutenAccessKey,
    affiliateId: config.rakutenAffiliateId,
    formatVersion: '2',
  });
}

export async function fetchRanking({ genreId, maxResults = 20, maxPerShop = 1 } = {}) {
  const params = apiParams();
  if (genreId) params.set('genreId', genreId);

  const url = `https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601?${params}`;
  console.log(`[searcher] Fetching ranking${genreId ? ` (genre: ${genreId})` : ' (all)'}...`);

  const res = await fetch(url);
  const data = await res.json();

  if (!data.Items) {
    console.error('[searcher] Ranking API error:', data);
    return [];
  }

  const products = saveWithDiversity(data.Items, 'ranking', maxResults, maxPerShop, genreId || 'all');
  if (genreId) markGenreFetched(genreId);
  return products;
}

export async function searchProductsAPI(keyword, { maxResults = 20, maxPerShop = 1, sort = '-reviewCount' } = {}) {
  const params = apiParams();
  params.set('keyword', keyword);
  params.set('sort', sort);
  params.set('hits', '30');

  const url = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601?${params}`;
  console.log(`[searcher] API search: "${keyword}" (sort: ${sort}, maxPerShop=${maxPerShop})`);

  const res = await fetch(url);
  const data = await res.json();

  if (!data.Items) {
    console.error('[searcher] Search API error:', data);
    return [];
  }

  return saveWithDiversity(data.Items, keyword, maxResults, maxPerShop, null);
}

function saveWithDiversity(items, keywordUsed, maxResults, maxPerShop, genreId) {
  const products = [];
  const shopCount = new Map();

  for (const item of items) {
    if (products.length >= maxResults) break;

    const shopName = item.shopName || '';
    const shopCode = item.shopCode || shopName;
    if (shopName && (shopCount.get(shopName) || 0) >= maxPerShop) continue;

    if (shopCode.includes('kobo') || shopCode.includes('book') || shopCode.includes('ebook') || shopCode.includes('biccamera')) continue;

    const itemUrl = extractItemUrl(item.itemUrl) || item.itemUrl;

    const product = {
      item_url: itemUrl,
      item_name: (item.itemName || '').substring(0, 200),
      shop_name: item.shopCode || shopName,
      shop_display_name: item.shopName || null,
      price: item.itemPrice || null,
      keyword_used: keywordUsed,
      category: item.genreName || null,
      image_url: item.mediumImageUrls?.[0] || item.smallImageUrls?.[0] || null,
      genre_id: genreId || item.genreId || 'all',
      catchcopy: (item.catchcopy || '').substring(0, 300) || null,
      description: (item.itemCaption || '').substring(0, 500) || null,
      review_average: item.reviewAverage || null,
      review_count: item.reviewCount || null,
    };

    upsertProduct(product);
    products.push(product);
    shopCount.set(shopName, (shopCount.get(shopName) || 0) + 1);
  }

  console.log(`[searcher] Saved ${products.length} products from ${shopCount.size} shops`);
  return products;
}

export async function fetchMultiGenreRanking(allocations) {
  const allProducts = [];
  for (const alloc of allocations) {
    const products = await fetchRanking({
      genreId: alloc.genre_id,
      maxResults: alloc.count + 5,
      maxPerShop: 1,
    });
    for (const p of products) {
      p.strategy_tag = `${alloc.strategy_tag}:${alloc.genre_name}`;
    }
    allProducts.push(...products.slice(0, alloc.count));
  }
  console.log(`[searcher] Multi-genre: ${allProducts.length} products from ${allocations.length} genres`);
  return allProducts;
}

function extractItemUrl(affiliateUrl) {
  if (!affiliateUrl) return null;
  const match = affiliateUrl.match(/pc=(https?%3A%2F%2Fitem\.rakuten\.co\.jp[^&]*)/);
  if (match) {
    return decodeURIComponent(match[1]);
  }
  if (affiliateUrl.includes('item.rakuten.co.jp')) {
    return affiliateUrl.split('?')[0];
  }
  return null;
}

export async function searchProducts(keyword, { maxResults = 20, maxPerShop = 1 } = {}) {
  if (config.rakutenAppId && config.rakutenAccessKey) {
    return searchProductsAPI(keyword, { maxResults, maxPerShop });
  }
  return searchProductsScrape(keyword, { maxResults, maxPerShop });
}

async function searchProductsScrape(keyword, { maxResults = 20, maxPerShop = 1 } = {}) {
  const browser = await chromium.launch({ headless: config.browser.headless, args: config.browser.launchArgs || [] });
  const context = await browser.newContext({
    viewport: config.browser.viewport,
    locale: config.browser.locale,
    userAgent: config.browser.userAgent,
  });

  const page = await context.newPage();
  const products = [];
  const shopCount = new Map();

  try {
    const searchUrl = `${config.urls.rakutenSearch}${encodeURIComponent(keyword)}/?s=2`;
    console.log(`[searcher] Scrape search: ${keyword} (maxPerShop=${maxPerShop})`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    const links = await page.$$('a[href*="item.rakuten.co.jp"]');
    for (const link of links) {
      if (products.length >= maxResults) break;
      try {
        const href = await link.getAttribute('href');
        const text = await link.innerText();
        if (href && text && text.length > 5) {
          const shopMatch = href.match(/item\.rakuten\.co\.jp\/([^/]+)\//);
          const shopName = shopMatch ? shopMatch[1] : null;
          if (shopName && (shopCount.get(shopName) || 0) >= maxPerShop) continue;

          const product = {
            item_url: href.split('?')[0],
            item_name: text.trim().substring(0, 200),
            shop_name: shopName,
            price: null,
            keyword_used: keyword,
            category: null,
            image_url: null,
          };
          upsertProduct(product);
          products.push(product);
          if (shopName) shopCount.set(shopName, (shopCount.get(shopName) || 0) + 1);
        }
      } catch {}
    }
    console.log(`[searcher] Saved ${products.length} products from ${shopCount.size} shops`);
  } finally {
    await browser.close();
  }
  return products;
}

if (process.argv[1] && process.argv[1].includes('searcher')) {
  const keyword = process.argv[2] || 'ワイヤレスイヤホン';
  searchProducts(keyword).catch(console.error);
}
