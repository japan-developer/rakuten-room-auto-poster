---
name: improvement-rules
description: 改善エージェントが守るべき編集可能パスと git ワークフロー
---

# Improvement Agent Rules

## 編集可能ファイル (これら以外を絶対に編集しない)

- `data/runtime-tuning.json`
- `.claude/skills/persona/SKILL.md`
- `.claude/skills/rakuten-room-comment/SKILL.md`
- `.claude/skills/hashtag-strategy/SKILL.md`
- `.claude/skills/weekly-review/SKILL.md`
- `.claude/skills/improvement-rules/SKILL.md` (= 自分自身、慎重に)
- `prompts/agent-post.md`
- `prompts/agent-review.md`
- `memory/feedback_human.md`
- `.claude/skills/feedback-portal/SKILL.md`

**禁止**: `src/`, `scripts/`, `data/*.db*`, `.env`, `data/auth-state.json`, `node_modules/`

## Skill ファイルサイズ上限

各 SKILL.md は **8 KB** 以下。超えそうなら古いシード例を削る。

## Git ワークフロー (この順番で実行)

```bash
git pull --ff-only origin main
git checkout -b review/$(date +%Y-%m-%d)

# === ここで Read/Edit して変更を加える ===
# data/runtime-tuning.json を必ず touch (updatedAt と weekStart を更新)
# Skills/prompts の編集は必要なときだけ

# Smoke test ゲート (これが落ちたら停止)
node scripts/agent.mjs smoke

# 商品取得が壊れていないか
node scripts/get-products.mjs --count 3

git add -A
git commit -m "chore(review): <summary>" -m "<rationale with data refs>"

git checkout main
git merge --ff-only review/$(date +%Y-%m-%d)
git push origin main
git branch -d review/$(date +%Y-%m-%d)
```

`git merge --ff-only` が失敗したら **停止** (force push しない)。

## コミットメッセージ規約

- subject: `chore(review): <一言要約>` (50 字以内)
- body: 各変更ごとに `- <change>: <data evidence>` の形式
- 例: `- bestHoursJst → [10,11,20]: hours 9-11 had 1.4 avg clicks vs 18-19's 0.3 (12 posts)`

## ロールバック

各週 1 コミットの原則。ロールバックは `git revert HEAD` 一発。
リフローで 90 日以内なら元の状態を再現できる。

## 失敗時

- smoke が落ちた → 変更を全部 `git restore .` して終了
- get-products が落ちた → 同上
- merge --ff-only が拒否された → リモートに先行コミットあり、停止して報告
- Edit が 3 回連続で失敗した → 停止
