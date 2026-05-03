import { chromium } from 'playwright';
import { config } from './config.mjs';
import fs from 'fs';
import path from 'path';

const STATE_PATH = path.join(config.rootDir, 'data', 'auth-state.json');

export async function launchAuthenticated() {
  const browser = await chromium.launch({
    headless: config.browser.headless,
    args: config.browser.launchArgs || [],
  });

  let context;
  if (fs.existsSync(STATE_PATH)) {
    try {
      context = await browser.newContext({
        storageState: STATE_PATH,
        viewport: config.browser.viewport,
        locale: config.browser.locale,
        userAgent: config.browser.userAgent,
      });
      const page = await context.newPage();
      await page.goto(config.urls.roomMyPage, { waitUntil: 'commit', timeout: 30000 });
      await page.waitForTimeout(5000);
      if (!page.url().includes('login')) {
        console.log('[auth] Restored saved session');
        return { browser, context, page };
      }
      await page.close();
      await context.close();
    } catch {}
  }

  context = await browser.newContext({
    viewport: config.browser.viewport,
    locale: config.browser.locale,
    userAgent: config.browser.userAgent,
  });

  const page = await context.newPage();
  await loginViaRoom(page);

  await context.storageState({ path: STATE_PATH });
  console.log('[auth] Session saved');

  return { browser, context, page };
}

async function loginViaRoom(page) {
  console.log('[auth] Logging in via ROOM SSO...');

  await page.goto('https://room.rakuten.co.jp/common/login', { waitUntil: 'commit', timeout: 60000 });
  await page.waitForTimeout(3000);

  if (page.url().includes('login.account.rakuten') || page.url().includes('grp02.id.rakuten')) {
    const emailInput = await page.waitForSelector(config.selectors.login.emailInput, { timeout: 10000 });
    await emailInput.fill(config.email);

    await page.getByRole('button', { name: '次へ' }).click();

    const passInput = await page.waitForSelector(config.selectors.login.passwordInput, { timeout: 15000 });
    await page.waitForTimeout(1500);
    await passInput.fill(config.password);

    const submitButtons = page.getByRole('button', { name: '次へ' });
    const count = await submitButtons.count();
    if (count > 1) {
      await submitButtons.nth(1).click();
    } else {
      await submitButtons.first().click();
    }

    try {
      await page.waitForURL(/room\.rakuten\.co\.jp/, { timeout: 30000 });
    } catch {
      throw new Error('[auth] Login failed — did not redirect to ROOM');
    }
    await page.waitForTimeout(3000);
  }

  console.log('[auth] Login successful, URL:', page.url());
}

async function loginViaAffiliate(page) {
  console.log('[auth] Logging in via affiliate...');

  await page.goto(config.urls.affiliateReport, {
    waitUntil: 'commit',
    timeout: 60000,
  });
  await page.waitForTimeout(3000);

  if (page.url().includes('login.account.rakuten') || page.url().includes('grp02.id.rakuten')) {
    const emailInput = await page.waitForSelector(config.selectors.login.emailInput, { timeout: 10000 });
    await emailInput.fill(config.email);
    await page.getByRole('button', { name: '次へ' }).click();

    const passInput = await page.waitForSelector(config.selectors.login.passwordInput, { timeout: 15000 });
    await page.waitForTimeout(1500);
    await passInput.fill(config.password);

    const submitButtons = page.getByRole('button', { name: '次へ' });
    const count = await submitButtons.count();
    if (count > 1) {
      await submitButtons.nth(1).click();
    } else {
      await submitButtons.first().click();
    }

    try {
      await page.waitForURL(/^(?!.*login\.account\.rakuten)/, { timeout: 15000 });
    } catch {
      throw new Error('[auth] Login failed — still on login page');
    }
    await page.waitForTimeout(2000);
  }

  console.log('[auth] Affiliate login successful');
}

export async function launchAuthenticatedForAffiliate() {
  const browser = await chromium.launch({
    headless: config.browser.headless,
    args: config.browser.launchArgs || [],
  });

  const context = await browser.newContext({
    viewport: config.browser.viewport,
    locale: config.browser.locale,
    userAgent: config.browser.userAgent,
  });

  const page = await context.newPage();
  await loginViaAffiliate(page);

  return { browser, context, page };
}

export async function ensureAuthenticated(page) {
  if (page.url().includes('login.account.rakuten') || page.url().includes('grp02.id.rakuten')) {
    console.log('[auth] Session expired, re-authenticating...');
    await loginViaRoom(page);
  }
}

export async function navigateWithAuth(page, url) {
  await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForTimeout(3000);
  await ensureAuthenticated(page);
  if (!page.url().startsWith(url)) {
    await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForTimeout(3000);
  }
}
