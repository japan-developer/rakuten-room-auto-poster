---
name: safety-guardrails
description: Hard rules every Rakuten ROOM agent must follow. Loaded by post, review, and smoke roles.
---

# Safety Guardrails (全エージェント必須)

## Off-limits files (絶対編集禁止)

- `src/auth.mjs` — 認証ロジック
- `src/db.mjs` — DBスキーマ／データアクセス
- `data/rakuten-room.db*` — SQLite データ本体
- `.env`, `data/auth-state.json`, `~/.claude/.credentials.json` — 機密
- `node_modules/`

これらに `Edit` / `Write` を試みてはいけない。Read は OK。

## Git rules

- `git push --force` / `git reset --hard origin/*` は禁止
- `--no-verify` でフックをスキップしてはいけない
- main への直接コミットは review エージェントの ff-merge ステップでのみ許可
- ブランチ名は `review/<YYYY-MM-DD>` 形式で作成

## Shop diversity (絶対条件)

- 1日の投稿で同じショップが2件以上に出てはいけない
- `scripts/get-products.mjs` の出力を必ず使い、自前で DB 直叩きしない
- 出力された商品に shop 重複があれば即停止する

## Failure stop

- 同じ操作 (同じ helper script、同じ Edit) で 3 回連続失敗したら停止
- 失敗の根本原因が分からない場合は exit コードを返してユーザーに委ねる

## Cost discipline

- helper script の出力を recall できる範囲で使い回す。同じ商品リストを再取得しない
- 最終出力 (報告 JSON、コミットメッセージ) は簡潔に

## Output

- 投稿エージェントは最後に `{posted: N, failed: M, log: <path>}` の JSON を 1 行で出力
- 改善エージェントは最後に `{commit: <sha>, changes: [...], merged: true|false}` を 1 行で出力
