#!/usr/bin/env node
/**
 * Engagement script: like posts and follow users on Rakuten ROOM.
 * Uses authenticated session + csrf_tkn to call internal APIs directly.
 */
import { launchAuthenticated } from '../src/auth.mjs';
import { config } from '../src/config.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, '..', 'data', 'engage-log.json');

function readLog() {
  try { return JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8')); } catch { return []; }
}

function writeLog(entry) {
  const log = readLog();
  log.push(entry);
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
  const trimmed = log.filter(e => e.timestamp >= cutoff);
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(trimmed, null, 2));
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitteredInterval(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

async function main() {
  const maxLikes = config.engage?.maxLikes ?? 20;
  const maxFollows = config.engage?.maxFollows ?? 5;
  const intervalMsMin = config.engage?.intervalMsMin ?? 6000;
  const intervalMsMax = config.engage?.intervalMsMax ?? 14000;

  const { browser, page } = await launchAuthenticated();
  let liked = 0;
  let followed = 0;
  const errors = [];

  let csrfFromXhr = null;
  page.on('request', req => {
    const url = req.url();
    if (url.includes('csrf_tkn=')) {
      const match = url.match(/csrf_tkn=([^&]+)/);
      if (match) csrfFromXhr = match[1];
    }
  });

  try {
    await page.goto('https://room.rakuten.co.jp/discover/items', {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    for (let i = 0; i < 20 && !csrfFromXhr; i++) {
      await page.waitForTimeout(1000);
    }

    const csrfTkn = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (meta) return meta.getAttribute('content');
      if (window.__CSRF_TOKEN__) return window.__CSRF_TOKEN__;
      return null;
    });

    const csrf = csrfTkn || csrfFromXhr;
    if (!csrf) {
      throw new Error('csrf_tkn が取得できなかった');
    }
    console.log(`[engage] csrf_tkn取得: ${csrf.substring(0, 10)}...`);

    const followCandidates = [];
    const seenIds = new Set();
    let afterId = null;
    let emptyPages = 0;

    while (liked < maxLikes && emptyPages < 3) {
      const qs = `limit=20${afterId ? `&after_id=${afterId}` : ''}`;
      const feed = await page.evaluate(async ({ csrf, qs }) => {
        const res = await fetch(`/api/collect?csrf_tkn=${csrf}&${qs}`, { credentials: 'include' });
        return res.json();
      }, { csrf, qs });

      const batch = feed?.data || [];
      if (batch.length === 0) { emptyPages++; continue; }
      emptyPages = 0;

      const lastId = batch.at(-1)?.id;
      if (lastId && lastId === afterId) {
        console.log('[engage] ページネーション停止: カーソル進まず');
        break;
      }
      afterId = lastId;

      for (const post of batch) {
        if (liked >= maxLikes) break;
        const collectId = post.id || post.collect_id;
        if (!collectId || seenIds.has(collectId)) continue;
        seenIds.add(collectId);

        if (post.user?.user_id === config.roomUserId) continue;

        try {
          const result = await page.evaluate(async ({ csrf, collectId }) => {
            const formData = new FormData();
            formData.append('collect_id', collectId);
            const res = await fetch(`/api/like/collect?csrf_tkn=${csrf}`, {
              method: 'POST',
              body: formData,
              credentials: 'include'
            });
            return { status: res.status, body: (await res.text()).slice(0, 200) };
          }, { csrf, collectId });

          if (result.status === 200) {
            liked++;
            if (liked % 10 === 0 || liked === maxLikes) {
              console.log(`[engage] いいね ${liked}/${maxLikes}`);
            }
            if (post.user?.username) followCandidates.push(post.user.username);
          } else {
            console.log(`[engage] いいね失敗 status=${result.status} post_id=${collectId} body=${result.body}`);
          }
        } catch (err) {
          errors.push(`like:${collectId}: ${err.message}`);
        }

        await sleep(jitteredInterval(intervalMsMin, intervalMsMax));
      }
    }

    console.log(`[engage] いいね完了: ${liked}件 (page seen: ${seenIds.size})`);

    const uniqueCandidates = [...new Set(followCandidates)];
    for (const username of uniqueCandidates) {
      if (followed >= maxFollows) break;

      try {
        await page.goto(`https://room.rakuten.co.jp/${username}/items`, {
          waitUntil: 'commit', timeout: 30000
        });
        await page.waitForTimeout(3000);

        const followBtn = await page.$('button[aria-label="フォローする"]');
        if (!followBtn) {
          console.log(`[engage] フォローボタンなし (${username} — 既フォロー or 自分)`);
          continue;
        }

        await followBtn.click();
        await page.waitForTimeout(2000);
        followed++;
        if (followed % 10 === 0 || followed === maxFollows) {
          console.log(`[engage] フォロー ${followed}/${maxFollows}`);
        }
      } catch (err) {
        errors.push(`follow:${username}: ${err.message}`);
      }

      await sleep(jitteredInterval(intervalMsMin, intervalMsMax));
    }
    console.log(`[engage] フォロー完了: ${followed}件 (候補 ${uniqueCandidates.length}人中)`);

  } finally {
    await browser.close();
  }

  const entry = {
    timestamp: new Date().toISOString(),
    liked,
    followed,
    errors,
  };
  writeLog(entry);

  const result = { liked, followed, errors };
  process.stdout.write(JSON.stringify(result) + '\n');
  if (liked === 0 && followed === 0) process.exit(1);
}

main().catch(err => {
  console.error(`[engage] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
