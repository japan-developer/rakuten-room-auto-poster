import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');

export const config = {
  // Auth
  email: process.env.RAKUTEN_EMAIL,
  password: process.env.RAKUTEN_PASSWORD,
  roomUserId: process.env.ROOM_USER_ID,
  rakutenAppId: process.env.RAKUTEN_APP_ID,
  rakutenAccessKey: process.env.RAKUTEN_ACCESS_KEY,

  // Paths
  rootDir: ROOT_DIR,
  dbPath: path.join(ROOT_DIR, 'data', 'rakuten-room.db'),
  screenshotsDir: path.join(ROOT_DIR, 'screenshots'),
  promptsDir: path.join(ROOT_DIR, 'prompts'),

  // URLs
  urls: {
    rakutenLogin: 'https://grp02.id.rakuten.co.jp/rms/nid/vc',
    affiliateReport: 'https://affiliate.rakuten.co.jp/report/',
    affiliateClickReport: 'https://affiliate.rakuten.co.jp/report/click/',
    affiliateOrderReport: 'https://affiliate.rakuten.co.jp/report/order/',
    rakutenSearch: 'https://search.rakuten.co.jp/search/mall/',
    roomTop: 'https://room.rakuten.co.jp/',
    roomMyPage: process.env.ROOM_USER_ID
      ? `https://room.rakuten.co.jp/${process.env.ROOM_USER_ID}/items`
      : 'https://room.rakuten.co.jp/my/items',
  },

  // Selectors (centralized for easy maintenance)
  selectors: {
    login: {
      emailInput: 'input[type="text"]',
      passwordInput: 'input[type="password"]',
      nextButton: 'button:has-text("次へ")',
    },
    room: {
      commentArea: 'textarea#collect-content, textarea[name="content"]',
      doneButton: 'button.collect-btn, button:has-text("完了")',
      roomMixLink: 'a[href*="room.rakuten.co.jp/mix"]',
    },
  },

  // Posting strategy
  posting: {
    dailyLimit: 40,
    minInterval: 85_000,
    maxInterval: 95_000,
    spreadHours: 2,
  },

  // Engagement (like + follow)
  engage: {
    maxLikes: 300,
    maxFollows: 100,
    intervalMsMin: 6000,
    intervalMsMax: 14000,
  },

  // Weekly strategy mix
  strategy: {
    exploitRatio: 0.6,
    exploreRatio: 0.3,
    discoverRatio: 0.1,
  },

  // Initial genre pool for ranking-based strategy
  genres: [
    { id: '100371', name: '食品' },
    { id: '100433', name: 'ダイエット・健康' },
    { id: '100939', name: '美容・コスメ・香水' },
    { id: '100227', name: '日用品雑貨・文房具・手芸' },
    { id: '100316', name: 'キッチン用品・食器・調理器具' },
    { id: '100026', name: 'インテリア・寝具・収納' },
    { id: '100533', name: 'レディースファッション' },
    { id: '551177', name: 'メンズファッション' },
    { id: '564500', name: 'キッズ・ベビー・マタニティ' },
    { id: '211742', name: 'スマートフォン・タブレット' },
    { id: '101213', name: 'スイーツ・お菓子' },
    { id: '100804', name: 'TV・オーディオ・カメラ' },
  ],

  // Schedule (UTC — JST-9)
  schedule: {
    postTimes: [
      '0 0 * * *',   // JST 09:00
      '30 3 * * *',  // JST 12:30
      '0 11 * * *',  // JST 20:00
    ],
    postCounts: [7, 7, 6],
    collectTime: '0 12 * * *',
    analyzeTime: '0 21 * * 5',
  },

  // Browser (memory-optimized args)
  browser: {
    headless: true,
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    launchArgs: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--no-sandbox',
      '--js-flags=--max-old-space-size=256',
    ],
  },
};
