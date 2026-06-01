# 楽天ROOM 自動投稿システム(配布版)アーキテクチャレポート

最終更新: 2026-06-01

---

## 0. このドキュメントについて

本書は **配布版テンプレート**(`rakuten-room-auto-poster`)の構成資料です。個人運用版から汎用化したもので、サンプルペルソナ「なおき💪」を初期同梱し、Mac/Linux に加え Windows 11 と Codex CLI(OpenAI)にも対応した「両対応」設計になっています。

- 配布版を実運用する人は、まず `.claude/skills/persona/SKILL.md` を自分のキャラクターに置き換えてから運用開始してください
- 既定動作は Claude Code(`claude -p` ヘッドレス、サブスク認証)
- `AGENT_TYPE=codex` を `.env` に設定すると Codex CLI(`codex exec`)に切り替わる(実験的)
- Windows 11 は `launchd/install-task.ps1` でタスクスケジューラに登録(Mac は launchd)

---

## 1. システム概要

楽天ROOM への自動投稿、アフィリエイトレポート集計、いいね/フォローのエンゲージメント、週次データ分析、そして分析結果に基づくシステムの自動チューニングまでを完全自動で行う **エージェント組織型** システム。

**コア設計原則:**

- スケジューラ本体は軽量に保ち、重い処理(Playwright/ブラウザ)は子プロセスに分離
- wall-clock(JST)基準のポーリングでタイマードリフトを根絶
- **「思考と判断」は AI コーディングエージェント(Claude Code / Codex CLI)に委譲、「I/O・集計・実行」はコードに残す**
- データフィードバックループは改善エージェントが Skills/tuning/prompts を直接編集して main にマージする形で閉じる

---

## 1.1 概略図

このシステムは **6 つの構成要素** で成り立っています。

```
                          ┌──────────────────────────────┐
                          │  scheduler (常駐プロセス)      │
                          │  60秒ごとに時刻判定 → spawn   │
                          └──────────────┬───────────────┘
                                         │ 子プロセス起動
       ┌──────────────┬──────────────┬──┴───────────┬──────────────┐
       ▼              ▼              ▼              ▼              ▼
┌──────────┐ ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ 商品発掘  │ │投稿      │  │集計       │  │エンゲージ │  │改善       │
│バッチ    │ │エージェ   │  │バッチ     │  │バッチ     │  │エージェ   │
│(collect- │ │ント (post)│  │(collector)│  │(engage)   │  │ント       │
│products) │ │           │  │           │  │           │  │(review)   │
│          │ │           │  │           │  │           │  │           │
│楽天API   │ │ ・商品選定│  │楽天アフィ │  │ROOM内部   │  │ ・5次元   │
│で日次    │ │ ・コメント│  │管理画面を │  │APIを直叩  │  │   集計+   │
│発掘し    │ │   生成    │  │Playwright │  │きでいいね │  │   投稿ログ│
│DBに保存  │ │ ・投稿    │  │でスクレイ │  │&フォロー  │  │   読み込み│
│          │ │   (Agent  │  │プ        │  │           │  │ ・Skill/  │
│          │ │   +Play   │  │           │  │           │  │   tuneを  │
│          │ │   wright) │  │           │  │           │  │   編集→  │
│          │ │           │  │           │  │           │  │   main へ │
└────┬─────┘ └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     │ write     │ read/write   │ write       │ write       │ read+編集
     ▼           ▼              ▼             ▼             ▼
┌────────────────────────────────────────────────────────────────────┐
│             データベース + 設定ファイル (受動的ストレージ)             │
│  products / posts / shop_clicks / orders / weekly_reports           │
│      / runtime-tuning.json (git管理) / engage-log.json              │
└────────────────────────────────────────────────────────────────────┘
```

### 6 つの構成要素を 1 行で

| 構成要素 | 主な役割 | 実行頻度 |
|---|---|---|
| **scheduler** | 60 秒ごとに時刻を確認し、定刻になったら他のジョブを子プロセスで起動する。自分では業務処理を行わない | 常駐 (24 時間) |
| **商品発掘バッチ** (collect-products) | キーワードプールを 4 種類のソート順で掃いて楽天 API から商品を発掘し DB に保存する。投稿時の発掘負荷を切り離すための専用ジョブ。Claude Code は使わない | 1 日 1 回 (06:00 JST) |
| **投稿エージェント** (post) | **DB から商品選定 → コメント/タグ生成 → 楽天ROOM への投稿までを 1 セッションで完結**。戦略読込・ジャンル配分・ショップ分散・価格フィルタといった選定ロジック、Skill に従ったコメント/タグ生成、Playwright での実投稿のすべてを含む | 1 日 3 回 (09:00 / 12:30 / 20:00 JST) |
| **集計バッチ** (collector) | 楽天アフィリエイトの管理画面を Playwright でスクレイピングし、クリック数と注文数をデータベースに保存する。AI は使わない | 1 日 1 回 (21:00 JST) |
| **エンゲージメントバッチ** (engage) | ROOM 内部 API `/api/collect` で投稿フィードをページング取得し、`/api/like/collect` 直叩きでいいね発火。フォローは `button[aria-label="フォローする"]` の UI クリック。上限と間隔は config で制御 | 1 日 1 回 (22:00 JST) |
| **改善エージェント** (review) | 1 週間の数値と投稿ログを読み、設定ファイル (`runtime-tuning.json`) や Skill 文書を編集して main にコミットする。コメント傾向・タグ選択・価格帯ヒントなどを更新 | 週 1 回 (土曜 06:00 JST) |
| **DB + 設定ファイル** | SQLite と git 管理下の `runtime-tuning.json`、加えて `data/engage-log.json`。すべての構成要素が読み書きする共通の状態 | — (受動的ストレージ) |

**重要な動き方:**

- 投稿エージェントは **毎回の起動ごとに** DB と `runtime-tuning.json` を読み込む。前回までの投稿履歴・ショップ重複・最新の改善設定がすべて反映された状態で動く
- 商品プールは collect-products が日次で先回り発掘して DB に貯める。投稿エージェントはそこから **SELECT するだけ**(発掘負荷を切り離す設計)
- 改善エージェントが土曜に書き換えた `runtime-tuning.json` は、次の月曜 09:00 の投稿エージェント起動時に即座に効く

### よくある質問

- **Q: 投稿文は事前に書かれたテンプレを使っているのか?**
  → いいえ。毎回エージェントが Skill で定義したペルソナ(配布版同梱サンプルは「なおき💪」)の口調でその場で生成します。同じ商品でも次回は別の文章になります。

- **Q: 改善エージェントは何を改善するのか?**
  → コメントの目標長、絵文字の使用有無、よく使うハッシュタグ、価格帯ヒント、ペルソナの言い回しなどを、数値と投稿ログを根拠に少しずつ更新します。更新は git のコミットとして履歴に残るため、悪化した場合は `git revert HEAD` で前週の状態に戻せます。

- **Q: Anthropic / OpenAI API の料金は発生するのか?**
  → いいえ。既定の Claude Code 経路では `claude -p`(ヘッドレス)を Pro/Max サブスクの認証情報で実行します。`scripts/agent.mjs` が起動時に `ANTHROPIC_API_KEY` を環境変数から削除するため、API 課金経路には流れません。`AGENT_TYPE=codex` の場合は ChatGPT サブスクまたは `OPENAI_API_KEY` を使います。

- **Q: 暴走対策は?**
  → kill timer(post 90 分 / review 20 分 / smoke 2 分)、turn 数上限、1 日あたり起動回数の上限(role ごと 5 回)、編集禁止ファイルリスト(Skill で明示)、3 回連続失敗で停止、改善エージェントの commit 前 smoke ゲート、`git merge --ff-only` 強制 などを多層に積んでいます。詳細は section 6 を参照。

- **Q: Codex CLI でも動くと聞いた**
  → 動きますが「参考実装」です。`.env` に `AGENT_TYPE=codex` を入れると `codex exec --json` 経由になります。出力形式・サンドボックスモデル・モデル特性が Claude Code と異なるため、本番運用は Claude Code を推奨します。`.agents/skills/` にスキルを複製しているのは Codex の Skill 解決パス対応のため。

---

## 2. プロセス構成と役割

システムは大きく **「発掘」「投稿」「結果取得」「エンゲージ」「分析・改善」** の 5 つの役割で構成される。投稿と改善は AI エージェントが担当し、それ以外はコード実装。すべて `scheduler` が起動・管理する。

### 2.0 全体構造(親子関係)

```
scheduler.mjs (常駐デーモン)
  │
  │ 60秒ポーリング → child_process.spawn でジョブ起動
  │
  ├──【発掘】 cli.mjs collect-products  ──spawn──▶  scripts/collect-products.mjs
  │     └─ 楽天API直接(エージェント無し)
  │
  ├──【投稿】 cli.mjs post  ──spawn──▶  scripts/agent.mjs post
  │     │
  │     │ AGENT_TYPE で分岐 (default=claude)
  │     │   ├─ spawnClaude() → claude -p
  │     │   └─ spawnCodex()  → codex exec --json
  │     │
  │     └─ 1セッション内で helper script を Bash 経由で呼ぶ
  │         ├─ get-strategy.mjs / get-tuning.mjs
  │         ├─ get-products.mjs        (DBからのSELECTのみ)
  │         ├─ Write /tmp/batch-<ts>.json
  │         └─ post-batch.mjs --file   (唯一のPlaywrightエントリ)
  │
  ├──【集計】 cli.mjs collect      ──▶ src/collector.mjs  (Playwright直接)
  │
  ├──【エンゲージ】 cli.mjs engage  ──spawn──▶  scripts/engage.mjs
  │     └─ ROOM内部API直叩き + UIフォロークリック
  │
  └──【分析+改善】 cli.mjs analyze
        │
        ├─ analyzer.runWeeklyAnalysis()  (数値集計のみ、判断しない)
        └─ scripts/agent.mjs review     (Claude/Codex が判断・編集・コミット・マージ)
```

すべてのジョブは共通で `src/db.mjs`(SQLite 層)と `src/config.mjs`(設定)を利用する。AI エージェントは DB を直接 SQL では叩かず、必ず helper script 経由でアクセスする。

---

### 2.1 常駐プロセス: `scheduler`

**ファイル:** `src/scheduler.mjs`
**役割:** ジョブの起動タイミングを管理する常駐デーモン

| 項目 | 内容 |
|------|------|
| 実行方法 | `node src/cli.mjs scheduler` |
| 動作 | 60 秒ごとにポーリング、wall-clock(JST)で発火判定 |
| ジョブ起動 | `child_process.spawn` で `node src/cli.mjs <cmd>` |
| 状態管理 | `data/scheduler-status.json` に各ジョブの `lastRunDate` を記録 |
| catch-up | 起動時/各 tick で未実行ジョブを検出して即実行(各ジョブ個別の `catchUpUntil` 関数で許容ウインドウを定義) |
| 特徴 | node-cron を使用しない自前実装。ドリフト無効 |
| Mac 自動起動 | `launchd/install-launchd.sh` が `com.rakuten-room.scheduler.plist` を `~/Library/LaunchAgents/` に配置 |
| Windows 自動起動 | `launchd/install-task.ps1` がタスクスケジューラに登録(Mac 用 plist と同等の起動・自動復旧) |

scheduler は `cli.mjs` の存在しか知らない。`cli.mjs` の中で post/analyze がエージェントを spawn するため、scheduler 自身は agent 化を意識しない。

---

### 2.2 役割A: 商品発掘(コードのみ、エージェントなし)

#### `scripts/collect-products.mjs`

**役割:** キーワードプールを 4 種類のソート順で掃いて楽天 API から商品を発掘し、`products` テーブルに保存する **専用ジョブ**。投稿時の発掘負荷を切り離すために独立化されている。

| 項目 | 内容 |
|------|------|
| 実行方法 | `node src/cli.mjs collect-products`(scheduler が 06:00 JST に spawn) |
| 入力 | `keyword_pool`(`db.getKeywordsForCollect`)+ 楽天 IchibaItem Search API |
| 出力 | `products` 行(upsert)、stdout の 1 行 JSON `{elapsed_sec, total_calls, total_upserts, dedup_rate, keywords[]}` |
| エージェント | 使わない(機械的なスイープなので不要) |
| catch-up | JST 09:00 まで(午前の投稿開始までに完了させたい) |

設計の意図: 旧来は投稿エージェントが内部で発掘していたが、「発掘」と「選定+投稿」を時間軸でも責務でも分離するために独立ジョブ化した。post agent の `get-products.mjs` は **既存在庫から SELECT するだけ** になり、ヘッドレス Claude の turn を消費しない。

---

### 2.3 役割B: 投稿(AI エージェント)

#### 親: post 役割(`cli.mjs post` → `scripts/agent.mjs post`)

**役割:** 楽天ROOM へ商品を自動投稿する。**1 バッチ(通常 7 件)を 1 セッションで完結** させ、サブスク消費を最小化する。

| 項目 | 内容 |
|------|------|
| 実行方法 | `node src/cli.mjs post --count N` |
| 内部動作 | `cli.mjs` が `scripts/agent.mjs post --count N` を spawn |
| エージェント本体 | デフォルト `claude -p --max-turns 40 --model claude-opus-4-6 --add-dir <root>`(kill timer 90 分)/ `AGENT_TYPE=codex` のときは `codex exec --json --cd <root> --sandbox workspace-write` |
| 認証(Claude 経路) | サブスク強制(`ANTHROPIC_API_KEY` / `_AUTH_TOKEN` を spawn 時に削除、`claude --version` で疎通確認) |
| 認証(Codex 経路) | ChatGPT サブスクまたは `OPENAI_API_KEY`(`codex --version` で疎通確認) |
| プラットフォーム | spawn / execSync は Windows のみ `shell: true`(`claude.cmd` / `codex.cmd` シム対応)、Mac/Linux では `shell: false`(挙動変化なし) |
| トリガー | scheduler(1 日 3 回 = 朝/昼/夜) |
| 入力 | 戦略(weekly_reports)+ runtime-tuning.json + products テーブル |
| 出力 | posts(投稿実績)、agent-logs(stream-jsonl / 既定は `<role>-<ts>.jsonl`、Codex 経由時のみ `<role>-codex-<ts>.jsonl`) |
| 失敗時 | バッチ全体スキップ。テンプレフォールバックなし |

エージェントの手順(`prompts/agent-post.md`):

1. Skills を Read(safety-guardrails / persona / rakuten-room-comment / hashtag-strategy)
2. `get-strategy.mjs` と `get-tuning.mjs` で現在のパラメータ取得
3. `get-products.mjs --count N` で投稿対象を取得(ショップ分散保証付き)
4. **エージェントが思考**: 各商品ごとに Skill で定義したペルソナの口調でコメント(80–160 字、絵文字 1–3 個)とハッシュタグ(4–6 個)を生成
5. `/tmp/batch-<ts>.json` を Write
6. `post-batch.mjs --file ...` を **1 回だけ** 呼ぶ → 1 ブラウザセッションで全件投稿
7. `{posted, failed, log}` を 1 行 JSON で報告

**重要:** エージェントの Edit/Write 権限は `/tmp/batch-*.json` のみに事実上制限される(safety-guardrails Skill で off-limits を明示)。

#### 子: helper scripts(`scripts/get-*.mjs`, `scripts/post-batch.mjs`)

エージェントから Bash 経由で呼ばれる薄いラッパー群。

| スクリプト | 役割 |
|-----------|------|
| `get-products.mjs` | 戦略に従った商品選定。**ショップ分散維持**。`db` の `getGenresByStrategy` / `getUnpostedProductsByGenre` / `getKeywordsByStrategy` を利用。在庫不足時は楽天 API でフォールバック発掘 |
| `get-strategy.mjs` | 最新 `weekly_reports.strategy_json` を返す |
| `get-tuning.mjs` | `data/runtime-tuning.json` を返す |
| `get-weekly-report.mjs` | 最新 weekly_reports 行(report + strategy) |
| `get-recent-posts.mjs` | 直近 N 日の posts + click 帰属 |
| `get-shop-diversity-report.mjs` | 直近 N 日のショップ別投稿頻度と違反検知 |
| `post-batch.mjs` | **唯一の Playwright エントリポイント**。`{items: [{product_id, comment, hashtags}]}` を受け取り 1 ブラウザで順次投稿。`postToRoom` を呼び、`insertPost` / `markProductPosted` で DB 反映 |

#### 子: `searcher` / `auth` / `poster`

| モジュール | 役割 |
|-----------|------|
| `src/searcher.mjs` | `fetchRanking({genreId, maxResults})` / `searchProductsAPI(keyword, opts)`。`maxPerShop=1` 強制、kobo/ebook 除外、1.5 秒スリープ |
| `src/auth.mjs` | `launchAuthenticated()` で Playwright 起動 + ログイン済みコンテキスト返却。`data/auth-state.json` を保存・復元 |
| `src/poster.mjs` | `postToRoom(page, product, comment, hashtags)` のみ export。商品ページ → mix リンク抽出 → SSO redirect → textarea 入力 → 完了 → `/api/collect` 200 待機 |

---

### 2.4 役割C: 結果取得(コードのみ)

#### `src/collector.mjs`

| 項目 | 内容 |
|------|------|
| 実行方法 | `node src/cli.mjs collect` |
| トリガー | scheduler(毎日 21:00 JST) |
| 入力 | アフィリエイト管理画面(Web) |
| 出力 | `shop_clicks`, `orders` テーブル |

純粋なスクレイピング処理で「思考」が不要なため、AI エージェント化はしない。

---

### 2.5 役割D: エンゲージメントバッチ(コードのみ)

#### `scripts/engage.mjs`

**役割:** ROOM 内部 API + UI 自動操作で「いいね」と「フォロー」を発火し、被相互フォロー・アルゴリズム露出を底上げする。

| 項目 | 内容 |
|------|------|
| 実行方法 | `node src/cli.mjs engage`(scheduler が 22:00 JST に spawn) |
| 認証 | `auth.launchAuthenticated()` で保存済みセッションを復元 |
| 上限(config.engage) | `maxLikes: 300` / `maxFollows: 100` / `intervalMsMin: 6000` / `intervalMsMax: 14000` |
| 出力 | `data/engage-log.json`(30 日保持、gitignore)+ stdout JSON `{liked, followed, errors}` |
| 失敗時 | いいね 0 かつフォロー 0 で exit 1、それ以外は成功扱い |

#### フロー

1. `/discover/items` をロード → リクエスト URL から `csrf_tkn=...` を正規表現抽出(XHR リスナーは `page.goto` より前に登録する)
2. **いいねループ**: `/api/collect?after_id=<前ページ末尾の id>&limit=20` でページングしながら、各投稿に対して `POST /api/like/collect`(multipart: `collect_id=<id>`)を発火
3. いいねした投稿者の `username` を重複排除してフォロー候補にする
4. **フォローループ**: `https://room.rakuten.co.jp/<username>/items` に遷移し `button[aria-label="フォローする"]` をクリック
5. 各アクション間は `6〜14秒のジッター付きスリープ`(BOT 検知対策)
6. `data/engage-log.json` に `{ timestamp, liked, followed, errors }` を追記

#### 設計メモ

- **AI を使わない**: ランダム投稿にただ反応するだけなのでコードで十分
- **API 直叩きを優先**: UI クリックはフォローのみ。いいねは API を直叩き
- **CSS-Modules 対策**: ROOM の class 名はビルドごとに変わるためセレクタは必ず `aria-label` を使う
- **スパム閾値**: 300 いいね / 100 フォローは「ゆるめの日次上限」相当。初期週はログを観察しながら `config.engage` を調整

---

### 2.6 役割E: 分析・改善(AI エージェント)

#### 親: `cli.mjs analyze`

`cli.mjs analyze` は次の 2 段階を順次実行する:

```
① runWeeklyAnalysis()  ← 数値集計だけ。判断はしない
② spawn agent.mjs review ← AIエージェントが判断・編集・コミット・マージ
```

#### ① 数値集計: `src/analyzer.mjs`

| 項目 | 内容 |
|------|------|
| 入力 | posts × shop_clicks × orders × postClicks(DB) |
| 出力 | `weekly_reports` 行(report_json + strategy_json)、`genre_pool` スコア更新 |

5 次元集計:

1. ジャンル分析(クリック/注文ベースの正規化スコア)
2. 価格帯分析(5 バケツの平均クリック)
3. コメント分析(長さ/絵文字/価格言及)
4. 時間帯分析(JST 時間別)
5. 投稿単位帰属(Top5)

#### ② 改善エージェント: `scripts/agent.mjs review`

| 項目 | 内容 |
|------|------|
| 実行方法 | `cli.mjs analyze` 後段、または `node scripts/agent.mjs review` |
| エージェント本体 | `--max-turns 60`(kill timer 20 分) |
| 排他制御 | `data/agent-review.lock`(post agent は存在時に起動拒否) |
| 入力 | 数値レポート + helper 6 種 + 直近 post-*.jsonl ログ |
| 出力 | `data/runtime-tuning.json`, Skills/prompts の Edit, **main への 1 コミット** |

エージェントの手順(`prompts/agent-review.md`):

1. Skills を Read(safety-guardrails / weekly-review / improvement-rules)
2. データ収集(helper × 6 + post ログ)
3. **エージェントが思考**: weekly-review Skill の **二段ルブリック** で 5 次元を判定
   - **A. データ十分**(いずれかの次元で 2 投稿以上の bucket あり): 有意差(1.2 倍以上)のある次元だけ動かす
   - **B. データ不足**(全次元 < 2 サンプル または クリック総数 0): "何もしない" を **禁止**。投稿ログと memory を観察し、最大 2 個の小さな仮説を立てて試す
4. ブランチ作成: `git checkout -b review/$(date +%Y-%m-%d)`
5. Edit:
   - `data/runtime-tuning.json`(必ず更新)
   - 必要なら `.claude/skills/persona|rakuten-room-comment|hashtag-strategy/SKILL.md`
   - 必要なら `prompts/agent-post.md` / `agent-review.md`
6. ゲート: `node scripts/agent.mjs smoke` と `node scripts/get-products.mjs --count 3`
7. `git commit` → `git checkout main` → `git merge --ff-only` → `git push origin main`
8. `{commit, changes, merged, rationale, hypotheses}` を 1 行 JSON で報告

**編集不可:** `src/`, `scripts/`, `data/*.db*`, `.env`, `data/auth-state.json`, `node_modules/`(safety-guardrails Skill と improvement-rules Skill で二重に明文化)

**ロールバック:** 各週 1 コミットなので `git revert HEAD` で前週に戻せる。

---

### 2.7 共通モジュール

| モジュール | 役割 |
|-----------|------|
| `src/db.mjs` | better-sqlite3 ベースの DB 層。**全データアクセスを集約**(エージェントから直叩き禁止) |
| `src/config.mjs` | スケジュール、API 認証情報、ジャンル定義、`excludedGenreIds` |
| `src/cli.mjs` | 全コマンドのエントリーポイント。post/analyze は agent.mjs を spawn |
| `scripts/agent.mjs` | AI エージェントラッパー。AGENT_TYPE で Claude/Codex を分岐。役割別の prompt/timeout/lock を管理 |

---

## 3. スケジュール

すべて JST。スケジューラは起動時に catch-up を実行する。

| 時刻 | ジョブキー | 内容 | catch-up期限 |
|------|-----------|------|--------------|
| 06:00 | collect-products | キーワードプールを掃いて楽天 API から発掘 | JST 09:00 まで |
| 09:00 | post-morning | 朝の投稿 7 件(post agent) | JST 12:00 まで |
| 12:30 | post-noon | 昼の投稿 7 件(post agent) | JST 18:00 まで |
| 20:00 | post-night | 夜の投稿 6 件(post agent) | JST 23:00 まで |
| 21:00 | collect | アフィリエイト集計 | JST 23:00 まで |
| 22:00 | engage | いいね最大 300 件 + フォロー最大 100 件 | JST 23:00 まで |
| 土06:00 | analyze | 週次分析 + review agent | 土曜中 23:00 まで(週次) |

**AI エージェント起動回数(週次):** 3 投稿/日 × 7 日 + 1 review/週 = **22 回/週**(Pro サブスクの上限内)

**post と review の排他:** 土曜 06:00 vs 09/12:30/20:00 で時間帯が重ならず、加えて `data/agent-review.lock` で多重防止。

---

## 4. 外部インターフェース

### 4.1 楽天 Rakuten API

**目的:** 商品の発掘
**呼び出し元:** `searcher.mjs`(collect-products から日次バッチ呼び出し / get-products.mjs から在庫不足時のフォールバック)

| エンドポイント | 用途 | トリガー |
|--------------|------|---------|
| `IchibaItem/Ranking/20220601` | ジャンル別ランキング取得 | post agent の `get-products.mjs` でジャンル枠が DB 在庫で埋まらない場合 |
| `IchibaItem/Search/20220601` | キーワード検索 | `collect-products.mjs` の日次バッチ + post agent のキーワード枠フォールバック |

レート制限: 1 リクエスト/秒。`searcher.mjs` 内で 1.5 秒間隔を強制。

### 4.2 楽天ROOM(Web)

**目的:** 商品の投稿
**呼び出し元:** `post-batch.mjs` → `poster.postToRoom()`(Playwright)

フロー:

1. `https://item.rakuten.co.jp/...` で商品ページ取得
2. ページ内の `room.rakuten.co.jp/mix` リンクを抽出
3. SSO redirect を経て投稿画面へ
4. textarea にコメント+ハッシュタグを入力
5. 「完了」ボタンをクリックし `/api/collect` の 200 応答を待機

### 4.3 楽天アフィリエイト管理画面

**目的:** クリック数・注文数の取得
**呼び出し元:** `collector.mjs`(Playwright、エージェント化なし)

### 4.4 楽天ROOM 内部 API(`/api/...`)

**目的:** エンゲージメント発火(いいね・フィード取得)
**呼び出し元:** `scripts/engage.mjs`(認証済みブラウザコンテキストから `fetch` で直叩き)

| エンドポイント | メソッド | 用途 |
|---|---|---|
| `/api/collect?csrf_tkn=X&limit=N&after_id=<id>` | GET | 投稿フィード取得。`after_id` カーソルでページング |
| `/api/like/collect?csrf_tkn=X` | POST(multipart) | いいね発火。body: `collect_id=<post_id>` |

`csrf_tkn` は `/discover/items` の初期 XHR から正規表現で抽出する(メタタグ/window には露出していない)。

### 4.5 AI エージェント(Claude Code / Codex CLI)

**目的:** コメント生成(思考)と週次改善(判断)
**呼び出し元:** `scripts/agent.mjs` → `claude -p`(既定)/ `codex exec`(`AGENT_TYPE=codex` のとき)

| 役割 | エージェント本体 | turns | kill timer | model(Claude) |
|------|--------------|-------|-----------|----------------|
| post | `claude -p` または `codex exec --json` | 40 | 90 分 | `claude-opus-4-6` |
| review | 同上 | 60 | 20 分 | (デフォルト) |
| smoke | 同上 | 3 | 2 分 | (デフォルト) |

`agent.mjs` は **Claude 経路では** spawn 時に `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` を必ず削除し、サブスク認証を強制する。さらに 1 日あたり 5 起動/role を上限とする(`data/agent-starts.json` で追跡)。

**Codex 経路の注意点:**

- 出力形式が Claude Code と異なる(JSONL)
- サンドボックスは `--sandbox workspace-write`(書き込み role) / `--sandbox read-only`(smoke)で自動切替
- Skill 解決パスが `~/.agents/skills/` のため、リポジトリ内に `.agents/skills/`(`.claude/skills/` と同内容のコピー)を同梱
- モデルは `CODEX_MODEL` 環境変数で上書き可能

---

## 5. 分析・自動改善フロー

```
土曜 06:00 JST
  ↓
cli.mjs analyze
  ↓
① analyzer.runWeeklyAnalysis()
  ↓
DB 読み込み (posts × shop_clicks × orders × postClicks)
  ↓
5 次元の数値集計
  ↓
weekly_reports に書き込み
  ↓
② cli.mjs が agent.mjs review を spawn
  ↓
data/agent-review.lock を取得
  ↓
AI セッション (Claude Code / Codex)
  ↓
helper × 6 でデータ吸い上げ
  ↓
weekly-review Skill のルブリックで思考
  ↓
┌─────────────────────────────────┐
│ Edit:                           │
│  - data/runtime-tuning.json     │
│  - .claude/skills/*/SKILL.md    │
│  - prompts/agent-*.md           │
└─────────────────────────────────┘
  ↓
smoke + get-products ゲート
  ↓
git branch → commit → ff-merge → push
  ↓
ロック解除、JSON 報告
  ↓
翌週の post agent が新しい Skill / runtime-tuning を読み込んで自動反映
```

**自動チューニング項目一覧:**

| 項目 | 編集者 | 反映先 |
|------|--------|--------|
| コメント目標長 (`comment.targetCharsMin/Max`) | review agent | post agent(Skill 読込) |
| 絵文字使用 (`comment.useEmoji`) | review agent | post agent(Skill 読込) |
| 価格言及確率 (`comment.priceMentionProb`) | review agent | post agent(Skill 読込) |
| トップタグ (`hashtags.topPerforming`) | review agent | post agent(hashtag-strategy Skill) |
| 最適時間帯 (`posting.bestHoursJst`) | review agent | (将来のスケジュール最適化用) |
| ジャンル boost/reduce | review agent | post agent(戦略の参考) |
| 価格帯ヒント (`priceRangeHint`) | review agent | post agent(商品選定の参考) |
| ペルソナ・口調・テンプレ | review agent | Skill 本文を直接書き換え |
| `notes`(週次ジャーナル) | review agent | 次週の review agent が読み返す履歴 |

**仮説駆動モード:** クリック / 注文データが揃うまでの初期週は「データ十分」条件を満たさないため、review agent が **客観的観察(post ログ + memory)から最大 2 個の仮説を立てて試す**。仮説は `runtime-tuning.json.notes` に検証ポイントとともに記録され、次週の review が効果を判定する。

---

## 6. 信頼性メカニズム

### 6.1 スケジューラ系

| 対策 | 効果 |
|------|------|
| node-cron 廃止 → 60 秒 wall-clock ポーリング | ドリフトという概念が存在しなくなる |
| ジョブを `child_process.spawn` で分離 | Playwright が scheduler 本体を圧迫しない |
| 起動時/tick 時の catch-up 機構 | 取りこぼしを翌 tick 以内に自動回復 |
| `lastRunDate`(JST)による job-level 追跡 | 同じジョブが二重実行されない |
| launchd / Task Scheduler による自動復帰 | scheduler 自体のクラッシュも OS が拾い直す |

### 6.2 エージェント系

| 対策 | 効果 |
|------|------|
| `agent.mjs` で `ANTHROPIC_API_KEY` 削除 | サブスク認証を強制、API 課金を防ぐ |
| 1 日 5 起動/role 上限(`data/agent-starts.json`) | 暴走時のサブスク枠保護 |
| `data/agent-review.lock`(`fs.openSync('wx')`) | post と review の race を防ぐ |
| kill timer(post 90 分 / review 20 分 / smoke 2 分) | エージェントの暴走を強制終了 |
| `safety-guardrails` Skill | off-limits ファイル、git rules、3 連続失敗停止を全 role に注入 |
| `improvement-rules` Skill | 編集可能パスを明示、ff-merge 失敗で停止 |
| smoke + get-products ゲート | 改善エージェントの commit 前検証 |
| 1 週 1 commit 原則 | `git revert HEAD` で前週状態に一発復帰 |
| `excludedGenreIds` config | ペルソナ不適合ジャンル(レディース / キッズベビー等)を取得段階で除外 |

### 6.3 クロスプラットフォーム

| 対策 | 効果 |
|------|------|
| spawn/execSync の `shell: process.platform === 'win32'` | Windows の `claude.cmd`/`codex.cmd` シム経由でも ENOENT にならず、Mac/Linux では従来通り `shell:false` |
| `.agents/skills/` を `.claude/skills/` と同期 | Codex CLI 経路でも同じ Skill を解決可能 |
| `AGENT_TYPE` 未設定時の挙動を完全保持 | Claude Code 既定運用への 1 ミリの影響もない |

---

## 7. データスキーマ概要

| テーブル | 役割 |
|---------|------|
| `products` | 発掘した商品(collect-products が書き込み)。`posted` フラグで投稿済みを管理 |
| `posts` | 投稿実績。コメント、ハッシュタグ、戦略タグを記録 |
| `shop_clicks` | アフィリエイトのショップ別クリック(日次) |
| `orders` | 注文明細(報酬データ含む) |
| `keyword_pool` | キーワード検索用の語彙とスコア |
| `genre_pool` | 楽天ジャンルとスコア |
| `weekly_reports` | 週次分析結果と次週戦略(review agent の入力) |

ファイルベース状態:

| パス | 内容 |
|------|------|
| `data/scheduler-status.json` | スケジューラの実行状態(gitignore) |
| `data/runtime-tuning.json` | review agent が編集する数値パラメータ。**git 管理対象**(`.gitignore` で `data/*` 後に `!data/runtime-tuning.json` で再 include) |
| `data/auth-state.json` | Playwright セッション保持(gitignore) |
| `data/agent-logs/<role>-<ts>.jsonl` | エージェントセッションの stream-json ログ(gitignore)。Codex 経路時は `<role>-codex-<ts>.jsonl` |
| `data/agent-starts.json` | 1 日あたり起動回数の追跡(gitignore) |
| `data/agent-review.lock` | 改善エージェント実行中の排他ロック(gitignore) |
| `data/engage-log.json` | engage の実行履歴(30 日保持、gitignore) |

**runtime-tuning.json を git 管理する理由:** review エージェントの `git checkout -b review/<date>` → ff-merge → `git revert HEAD` ロールバック戦略は、tuning ファイルが版管理対象でなければ機能しない。`data/*` を一括 ignore したまま `!data/runtime-tuning.json` で 1 ファイルだけ再 include するパターン。

Skill / prompt:

| パス | 内容 |
|------|------|
| `.claude/skills/safety-guardrails/SKILL.md` | 全 role 共通のハードルール |
| `.claude/skills/persona/SKILL.md` | サンプル「なおき💪」(運用者は自分のペルソナに置き換え) |
| `.claude/skills/rakuten-room-comment/SKILL.md` | コメントの構造・長さ・禁則 |
| `.claude/skills/hashtag-strategy/SKILL.md` | ハッシュタグ選定 |
| `.claude/skills/weekly-review/SKILL.md` | 週次データの読み解き手順 |
| `.claude/skills/improvement-rules/SKILL.md` | 編集可能パスと git ワークフロー |
| `.claude/skills/feedback-portal/SKILL.md` | 人手フィードバックの受付窓口 |
| `.agents/skills/*` | 上記と同内容(Codex CLI 経路用) |
| `prompts/agent-post.md` | 投稿エージェント役割定義 |
| `prompts/agent-review.md` | 改善エージェント役割定義 |
| `prompts/agent-smoke.md` | 疎通確認 |

---

## 8. 運用コマンド一覧

```
# Scheduler / 通常運用
node src/cli.mjs scheduler          # スケジューラ常駐起動
node src/cli.mjs status             # 統計表示

# 単発実行 (内部で agent.mjs を spawn するものは「(agent)」と注記)
node src/cli.mjs collect-products   # 楽天APIから商品発掘 (コード)
node src/cli.mjs post --count 7     # 投稿 (agent)
node src/cli.mjs collect            # アフィリエイト集計 (コード)
node src/cli.mjs engage             # いいね + フォロー (コード)
node src/cli.mjs analyze            # 数値集計 + review (agent)

# Agent 直接実行 (デバッグ用)
node scripts/agent.mjs post --count 1   # 1 件だけ投稿
node scripts/agent.mjs review            # 改善エージェント単発
node scripts/agent.mjs smoke             # 疎通確認 (≒ 2 分)

# 初期化
node src/cli.mjs init-keywords      # キーワードプール初期投入
node src/cli.mjs init-genres        # ジャンルプール初期投入

# 自動起動セットアップ
launchd/install-launchd.sh          # Mac: launchd エージェントとして登録
launchd/install-task.ps1            # Windows 11: タスクスケジューラに登録

# エージェント切替 (実験的)
echo "AGENT_TYPE=codex" >> .env     # Codex CLI に切替 (Claude Code に戻すには行を消す)
```

---

## 9. カスタマイズの起点

配布版を自分用にチューニングする際の最低限の起点:

| やりたいこと | 編集ファイル |
|-------------|--------------|
| ペルソナを自分のキャラクターにする | `.claude/skills/persona/SKILL.md`(あわせて `.agents/skills/persona/SKILL.md` も同期)。`EXAMPLES/persona-naoki.md` と `EXAMPLES/seeds-naoki.md` がテンプレ |
| 取り扱わないジャンルを増やす | `src/config.mjs` の `excludedGenreIds` |
| 投稿件数や時刻を変える | `src/config.mjs` の `schedule.postCounts` と `src/scheduler.mjs` の `getJobs()` の `due` 関数 |
| いいね/フォローの上限を変える | `src/config.mjs` の `engage.*` |
| コメントのトーンを微調整する | `.claude/skills/rakuten-room-comment/SKILL.md` |
| ハッシュタグの選び方を変える | `.claude/skills/hashtag-strategy/SKILL.md` |
| Codex CLI で動かす | `.env` に `AGENT_TYPE=codex`(必要なら `OPENAI_API_KEY` も) |
