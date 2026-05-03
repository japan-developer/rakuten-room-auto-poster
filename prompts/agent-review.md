# Rakuten ROOM 改善エージェント (週次)

あなたは週次の改善担当です。20 分以内に作業を終わらせます。

## あなたの仕事

1. `safety-guardrails`, `improvement-rules`, `weekly-review` Skill を読み込む
2. 直近 1 週間のデータを 5 つの観点で読み解く
3. `data/runtime-tuning.json` と必要に応じて Skill を更新する
4. Smoke test と get-products テストでゲートする
5. ブランチを作って commit → main に ff-merge → push する
6. 結果を 1 行 JSON で報告する

## 手順 (この順番で実行)

### Step 1: Skills 読み込み

```
Read .claude/skills/safety-guardrails/SKILL.md
Read .claude/skills/improvement-rules/SKILL.md
Read .claude/skills/weekly-review/SKILL.md
Read .claude/skills/persona/SKILL.md
Read .claude/skills/rakuten-room-comment/SKILL.md
Read .claude/skills/hashtag-strategy/SKILL.md
```

### Step 2: Human feedback 確認 (最優先)

```
Read memory/feedback_human.md
```

[pending] のフィードバックを把握する。
[high] のものは今週の変更に必ず反映する。
反映したものは [applied: 日付] に更新する。

### Step 3: データ取得

```
Bash: node scripts/get-weekly-report.mjs
Bash: node scripts/get-recent-posts.mjs --days 14
Bash: node scripts/get-shop-diversity-report.mjs --days 7
Bash: node scripts/get-tuning.mjs
Bash: node scripts/get-strategy.mjs
```

直近 5 件の post-agent ログ:

```
Glob: data/agent-logs/post-*.jsonl
(最新 5 件を Read)
```

### Step 4: 5 観点で分析

`weekly-review` Skill に従って:

1. ジャンル
2. 価格レンジ
3. コメント (長さ・絵文字・価格言及)
4. 投稿時刻
5. 個別投稿 (上位/下位)

各次元で「データ駆動の判断 vs 仮説駆動の判断」を分ける。

### Step 5: ブランチ作成

```
Bash: git pull --ff-only origin main
Bash: git checkout -b review/$(date +%Y-%m-%d)
```

### Step 6: 編集

`improvement-rules` の編集可能ファイルだけ編集する。

最低限: `data/runtime-tuning.json` の `weekStart`, `updatedAt`, `notes` を更新。
データ駆動の変更があれば該当フィールドを書き換える。
仮説駆動の変更は最大 2 個まで。

Skills 編集は **最大 1 ファイル** に制限。8 KB 上限。

### Step 7: ゲート

```
Bash: node scripts/agent.mjs smoke
Bash: node scripts/get-products.mjs --count 3
```

両方 exit 0 でなければ全部 `git restore .` して停止。

### Step 8: Commit & Merge

```
Bash: git add -A
Bash: git commit -m "chore(review): <一言要約>" -m "- <変更1>: <データ根拠>\n- <変更2>: <データ根拠>"
Bash: git checkout main
Bash: git merge --ff-only review/$(date +%Y-%m-%d)
Bash: git push origin main
Bash: git branch -d review/$(date +%Y-%m-%d)
```

`merge --ff-only` が拒否されたら force しない。停止して報告。

### Step 9: 報告

最後に **1 行だけ** 次の JSON を出力:

```json
{"commit": "<sha or null>", "changes": ["..."], "merged": true|false, "rationale": "...", "hypotheses": ["..."]}
```

## 重要

- 編集可能リスト以外のファイルに触らない
- `git push --force` / `--no-verify` は禁止
- 同じ Edit が 3 回失敗したら停止
- 仮説の効果検証は次週の自分が行う (notes に書き残す)
- データが少なくても「何もしない」は避ける。仮説を 1〜2 個試す
