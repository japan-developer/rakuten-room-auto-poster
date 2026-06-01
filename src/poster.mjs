import fs from 'fs';
import { ensureAuthenticated } from './auth.mjs';
import { config } from './config.mjs';

export async function postToRoom(page, product, comment, hashtags) {
  await ensureAuthenticated(page);

  console.log(`[poster] Loading product page...`);
  await page.goto(product.item_url, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForTimeout(8000);

  if (!page.url().includes('item.rakuten.co.jp')) {
    throw new Error('Product page redirected (likely discontinued): ' + page.url());
  }

  const isSoldOut = await page.evaluate(() => {
    return (document.body.innerText || '').includes('この商品は売り切れです');
  }).catch(() => false);

  if (isSoldOut) {
    const err = new Error('SOLD_OUT: この商品は売り切れです');
    err.code = 'SOLD_OUT';
    throw err;
  }

  const roomLink = await page.$eval(
    'a[href*="room.rakuten.co.jp/mix"]',
    el => el.href
  ).catch(() => null);

  if (!roomLink) {
    throw new Error('Could not find "ROOMに投稿" link on product page');
  }
  console.log(`[poster] ROOM link: ${roomLink}`);

  await page.goto(roomLink, { waitUntil: 'commit', timeout: 60000 });

  try {
    await page.waitForURL(/room\.rakuten\.co\.jp/, { timeout: 30000 });
  } catch {
    if (page.url().includes('login.account.rakuten') || page.url().includes('grp02.id.rakuten')) {
      console.log('[poster] SSO requires login, authenticating...');
      await ensureAuthenticated(page);
      await page.goto(roomLink, { waitUntil: 'commit', timeout: 60000 });
      await page.waitForURL(/room\.rakuten\.co\.jp/, { timeout: 30000 });
    }
  }
  await page.waitForTimeout(5000);

  // 「すでにコレ！している商品です」モーダル検知
  const alreadyModal = page.locator('div.dialog-container.modal-popup:has-text("すでにコレ"), div:has-text("すでにコレ！している商品です")').first();
  const isAlready = await alreadyModal.isVisible().catch(() => false);
  if (isAlready) {
    console.log('[poster] ALREADY_COLLECTED modal detected, dismissing...');
    const okBtn = page.locator('div.dialog-container.modal-popup button:has-text("OK"), button:has-text("OK"):visible').first();
    await okBtn.click({ timeout: 5000 }).catch((e) => {
      console.error(`[poster] could not click OK on modal: ${e.message.split('\n')[0]}`);
    });
    const err = new Error('ALREADY_COLLECTED: item already exists in ROOM');
    err.code = 'ALREADY_COLLECTED';
    throw err;
  }

  try {
    await page.waitForSelector('.collect-item-name, [class*="itemName"], h1, h2', {
      state: 'visible',
      timeout: 10000,
    });
  } catch {
    const hasButton = await page.$('button.collect-btn');
    if (!hasButton) {
      throw new Error('ROOM mix page did not load product preview');
    }
  }
  await page.waitForTimeout(2000);

  await page.screenshot({ path: `${config.screenshotsDir}/post_before_comment.png`, fullPage: true });

  const commentArea = await page.waitForSelector('textarea#collect-content, textarea[name="content"]', { timeout: 15000 });
  await commentArea.fill('');
  await commentArea.fill(`${comment}\n${hashtags}`);
  await page.waitForTimeout(1000);

  await page.screenshot({ path: `${config.screenshotsDir}/post_after_comment.png`, fullPage: true });

  const doneButton = await page.waitForSelector('button.collect-btn, button:has-text("完了")', { timeout: 10000 });

  const collectPromise = page.waitForResponse(
    resp => resp.url().includes('/api/collect'),
    { timeout: 30000 }
  ).catch(() => null);

  try {
    await doneButton.click();
  } catch (clickErr) {
    const failDir = `${config.screenshotsDir}/failures`;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const failPath = `${failDir}/post_fail_${product.id}_${stamp}.png`;
    const overlayInfo = await page.evaluate(() => {
      const sel = 'div.background, .modal-backdrop, [class*="overlay"], [class*="backdrop"], [class*="modal"]';
      const els = Array.from(document.querySelectorAll(sel));
      return els.slice(0, 20).map(el => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          className: el.className,
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          zIndex: cs.zIndex,
          pointerEvents: cs.pointerEvents,
          position: cs.position,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        };
      });
    }).catch((e) => ({ error: e.message }));
    try {
      fs.mkdirSync(failDir, { recursive: true });
      await page.screenshot({ path: failPath, fullPage: true });
      console.error(`[poster] Click FAILED, screenshot: ${failPath}`);
      console.error(`[poster] Overlay diagnostic: ${JSON.stringify(overlayInfo)}`);
    } catch (ssErr) {
      console.error(`[poster] Could not save failure screenshot: ${ssErr.message}`);
    }
    throw clickErr;
  }
  console.log(`[poster] Clicked 完了, waiting for /api/collect response...`);

  const collectResp = await collectPromise;
  if (collectResp) {
    const status = collectResp.status();
    const body = await collectResp.text().catch(() => '(no body)');
    if (status !== 200) {
      console.error(`[poster] /api/collect FAILED: status=${status} body=${body.substring(0, 300)}`);
      throw new Error(`Collect API returned status ${status}: ${body.substring(0, 200)}`);
    }
    try {
      const json = JSON.parse(body);
      if (json.status === 'error' || json.msg_code) {
        console.error(`[poster] /api/collect FAILED: status=200 body=${body.substring(0, 300)}`);
        throw new Error(`Collect API error ${json.msg_code || 'unknown'}: ${json.message || body.substring(0, 200)}`);
      }
    } catch (e) {
      if (e.message.startsWith('Collect API error')) throw e;
    }
    console.log(`[poster] /api/collect response: 200 OK`);
  } else {
    console.log(`[poster] No /api/collect response caught, waiting 10s...`);
    await page.waitForTimeout(10000);
  }

  await page.screenshot({ path: `${config.screenshotsDir}/post_done.png`, fullPage: true });

  const currentUrl = page.url();
  console.log(`[poster] Post result URL: ${currentUrl}`);
  return currentUrl.includes('room.rakuten.co.jp') ? currentUrl : null;
}
