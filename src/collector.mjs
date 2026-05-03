import { launchAuthenticatedForAffiliate } from './auth.mjs';
import { config } from './config.mjs';
import { upsertShopClicks, insertOrder } from './db.mjs';
import fs from 'fs';
import path from 'path';

export async function collectReports({ screenshotOnly = false } = {}) {
  const { browser, context, page } = await launchAuthenticatedForAffiliate();

  try {
    const currentUrl = page.url();
    if (!currentUrl.includes('affiliate.rakuten.co.jp/report')) {
      console.log('[collector] Navigating to affiliate report...');
      await page.goto(config.urls.affiliateReport, { waitUntil: 'commit', timeout: 60000 });
      await page.waitForTimeout(8000);
    } else {
      console.log('[collector] Already on affiliate report page');
      await page.waitForTimeout(3000);
    }

    try {
      await page.waitForSelector('text=ショップ別', { state: 'visible', timeout: 15000 });
    } catch {
      console.log('[collector] Tabs not visible, navigating to report page...');
      await page.goto(config.urls.affiliateReport, { waitUntil: 'commit', timeout: 60000 });
      await page.waitForTimeout(8000);
      await page.waitForSelector('text=ショップ別', { state: 'visible', timeout: 15000 });
    }

    await saveScreenshot(page, 'collector_report_top.png');

    const clickResults = await collectShopClicks(page, screenshotOnly);
    const orderResults = await collectOrders(page, screenshotOnly);

    console.log(`[collector] Done: ${clickResults.count} shop-click records, ${orderResults.count} order records`);
    return { clicks: clickResults, orders: orderResults };
  } finally {
    await browser.close();
  }
}

async function collectShopClicks(page, screenshotOnly) {
  console.log('[collector] Collecting shop clicks...');

  await page.goto('https://affiliate.rakuten.co.jp/report/shop', { waitUntil: 'commit', timeout: 60000 });
  await page.waitForTimeout(8000);

  await saveScreenshot(page, 'collector_shop_tab.png');
  console.log('[collector] Shop tab URL:', page.url());

  if (screenshotOnly) {
    console.log('[collector] Screenshot-only mode, skipping data collection');
    return { count: 0 };
  }

  try {
    await page.waitForSelector('table', { timeout: 15000 });
  } catch {
    console.error('[collector] No table found on shop tab');
    await saveScreenshot(page, 'collector_shop_tab_error.png');
    return { count: 0 };
  }

  let totalRecords = 0;
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const rows = await page.$$eval('table tbody tr', trs =>
    trs.map(tr => {
      const cells = tr.querySelectorAll('td');
      return Array.from(cells).map(td => td.innerText.trim());
    })
  );

  for (const row of rows) {
    if (row.length >= 5) {
      const shopName = row[1];
      const clicks = parseInt(row[3]?.replace(/,/g, ''), 10);

      if (shopName && shopName !== '合計' && !isNaN(clicks)) {
        upsertShopClicks({ shop_name: shopName, date: dateStr, clicks });
        totalRecords++;
      }
    }
  }

  console.log(`[collector] Shop clicks: ${totalRecords} records`);
  return { count: totalRecords };
}

async function collectOrders(page, screenshotOnly) {
  console.log('[collector] Collecting orders...');

  await page.goto('https://affiliate.rakuten.co.jp/report/order', { waitUntil: 'commit', timeout: 60000 });
  await page.waitForTimeout(8000);

  await saveScreenshot(page, 'collector_order_tab.png');
  console.log('[collector] Order tab URL:', page.url());

  if (screenshotOnly) {
    console.log('[collector] Screenshot-only mode, skipping data collection');
    return { count: 0 };
  }

  try {
    await page.waitForSelector('table', { timeout: 15000 });
  } catch {
    console.error('[collector] No table found on order tab');
    await saveScreenshot(page, 'collector_order_tab_error.png');
    return { count: 0 };
  }

  let totalRecords = 0;

  const rows = await page.$$eval('table tbody tr', trs =>
    trs.map(tr => {
      const cells = tr.querySelectorAll('td');
      return Array.from(cells).map(td => td.innerText.trim());
    })
  );

  for (const row of rows) {
    if (row.length >= 6) {
      const orderDate = row[0];
      const commission = parseInt(row[1]?.replace(/[¥,円]/g, ''), 10);
      const price = parseInt(row[2]?.replace(/[¥,円]/g, ''), 10);
      const genre = row[3];
      const shopName = row[4];
      const productName = row[5];

      if (productName && productName !== '' && orderDate !== '合計') {
        insertOrder({
          product_name: productName,
          shop_name: shopName,
          order_date: normalizeDate(orderDate),
          price: isNaN(price) ? 0 : price,
          commission: isNaN(commission) ? 0 : commission,
          keyword_guess: genre || null,
        });
        totalRecords++;
      }
    }
  }

  console.log(`[collector] Orders: ${totalRecords} records`);
  return { count: totalRecords };
}

function normalizeDate(dateStr) {
  const match = dateStr.match(/(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  }
  return dateStr;
}

function saveScreenshot(page, filename) {
  const dir = config.screenshotsDir;
  fs.mkdirSync(dir, { recursive: true });
  return page.screenshot({ path: path.join(dir, filename), fullPage: true });
}

if (process.argv[1] && process.argv[1].includes('collector')) {
  const screenshotOnly = process.argv.includes('--screenshot-only');
  collectReports({ screenshotOnly }).catch(console.error);
}
