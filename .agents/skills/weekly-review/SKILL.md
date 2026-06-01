---
name: weekly-review
description: 週次データの読み解き手順と判断ルブリック (改善エージェント用)
---

# Weekly Review Procedure

## Human Feedback の処理（最優先）

データ収集の前に必ず以下を実行する:
1. `memory/feedback_human.md` の [pending] 項目を全件読む
2. [high] は今週の変更に必ず反映する
3. [medium] はデータ駆動の変更と合わせて反映する
4. 反映したものは [applied: 日付] に更新する
5. notes にも「Human feedback反映: <内容>」を記録する

## 入力データ (この順番で取得)

1. `node scripts/get-weekly-report.mjs` — 5次元の集計
2. `node scripts/get-recent-posts.mjs --days 14` — 投稿本文・クリック実績
3. `node scripts/get-shop-diversity-report.mjs --days 7` — 分散健全性
4. `node scripts/get-tuning.mjs` — 現在の runtime tuning
5. `node scripts/get-strategy.mjs` — 最新の戦略
6. `data/agent-logs/post-*.jsonl` 直近 5 件 (Glob で見つけて Read) — 投稿エージェントの挙動

## 5 つの観点

| # | 次元 | 着目する数値 |
|---|------|--------------|
| 1 | ジャンル | `genreClickScores`, `genreOrderScores`, `genrePostCounts` |
| 2 | 価格 | `priceAnalysis.bestRange` (最低 2 投稿で qualify) |
| 3 | コメント | `commentAnalysis.bestLength`, `emojiEffect`, `priceEffect` |
| 4 | 投稿時刻 | `timeAnalysis.bestHour` (最低 2 投稿で qualify) |
| 5 | 個別投稿 | `attribution[].clicks` 上位/下位 |

## 判断ルブリック (重要)

判断は **データ駆動を最優先**、不足時は **仮説駆動で前進** の二段構え。

### A. データが十分ある時 (1 つでも次元で 2 投稿以上の bucket がある)

> **その次元は数値の指示に従う**

- bucket 内の投稿数が < 2 → noise として無視
- 1 週で観測した「ベスト」が前週と矛盾 → 前週の判断を尊重 (lock-in 効果)
- 統計的に有意な差 (1.2 倍以上) が出ている次元のみ動かす

### B. データが不十分な時 (全次元 < 2 サンプル、またはクリック総数 0)

**「何もしない」ではなく、仮説駆動で 1〜2 個の小さな改善を試す。** 完全な様子見は学習機会の損失。

仮説の出し方:

1. **直前 1〜2 週の投稿ログ (post-*.jsonl) を読み、客観的に観察する**
   - コメントのバリエーションは十分か
   - ハッシュタグは固定化していないか
   - ペルソナの口調が崩れていないか
   - 商品ジャンルの偏りがないか
   - 現在の `priceRangeHint` で実際に取れている商品が枯れていないか
2. **memory ファイル (`memory/feedback_*.md`) のフィードバックを優先確認**
3. **過去の `notes` 履歴と矛盾しない範囲で 1 つだけ実験を設定**
4. 仮説は 1 回の review で **最大 2 個**

仮説変更の例 (どれか 1〜2 個):

- `hashtags.topPerforming` が空 → ジャンル人気タグから上位 2 個を仮置き
- `comment.priceMentionProb` を 0.3 → 0.4 (or 0.2) に微調整 (±0.1 まで)
- `priceRangeHint` の幅をやや広げる/狭める (±30% まで)
- `posting.bestHoursJst` の順序を入れ替えて午前/午後の比率を試す
- Skill 本文 (persona / rakuten-room-comment) に **シード例を 1 つ追加** (削除より追加優先)

### 共通原則

- クリック 0 が続く → 構造を変える前にショップ分散と投稿時刻を疑う
- 仮説を入れたら次週の review で **必ず効果を検証** (notes に書き残す)
- 同じ仮説を 3 週連続で繰り返さない
- 1 回の review で `runtime-tuning.json` 以外の Skill を変えるのは最大 1 ファイル

## 出力すべき変更案

`runtime-tuning.json` の以下のフィールドだけ書き換える:

- `comment.targetCharsMin / targetCharsMax`
- `comment.useEmoji`
- `comment.priceMentionProb`
- `hashtags.topPerforming` (最大 5 個)
- `posting.bestHoursJst` (最大 3 個)
- `genre.boost` / `genre.reduce` (名前ベース)
- `priceRangeHint` (min/max)
- `seasonal.keywords` (1〜2ヶ月先の季節商品キーワード、最大 6 個)
- `seasonal.updatedMonth` (更新した月 `YYYY-MM`)
- `evergreen.keywords` (通年需要キーワード、最大 4 個)

`weekStart` と `updatedAt` は必ず更新。

## 季節キーワードの管理

`seasonal.keywords` は 1〜2ヶ月先に需要が高まる商品の検索キーワード。

- `seasonal.updatedMonth` が先月以前なら、今月の review で必ず更新する
- 現在月+1〜2ヶ月の季節を想像してキーワードを選ぶ (例: 4月→6月向け = UV対策・雨具)
- 具体的なブランド名ではなく、カテゴリ+特徴で書く (例: `レインコート おしゃれ`)
- 最大 6 個

`evergreen.keywords` は通年で需要がある商品の検索キーワード。
- 季節に依存しないため頻繁な入替は不要
- Human feedback で追加要望があれば追記する (最大 4 個)

## Skills の更新

- 必要なら `persona`, `rakuten-room-comment`, `hashtag-strategy` の SKILL.md を編集
- ただし: **8KB 以下に収める** こと
- 変更理由を必ず Git コミットメッセージ本文に **データ根拠付き** で書く

## notes フィールドの運用

`runtime-tuning.json.notes` は週次ジャーナル。次週のあなたが読んで判断できるよう書く。

最低限含めるもの:
- 当週の主要数値 (`<N>投稿/<C>クリック/<O>注文`)
- データ駆動で動かした次元 (なければ「該当なし」)
- 仮説駆動で動かした項目と検証ポイント
- 前週の仮説の検証結果 (該当があれば)

過去 4 週分くらいの履歴を残し、それより古いものは要約して圧縮する。

## 出力フォーマット (最終 1 行)

```json
{"commit": "<sha or null>", "changes": ["..."], "merged": true|false, "rationale": "...", "hypotheses": ["..."]}
```
