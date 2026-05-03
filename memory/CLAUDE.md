# Rakuten ROOM Auto-Poster

## このプロジェクトの背景
ユーザーが楽天ROOMで成果を出すために、Claude Code が
裏で自動投稿・週次改善を行うシステム。

## あなた（Claude）の役割
スケジューラから定期的に呼び出される自律エージェント:
- 投稿エージェント (post): 1日3回、商品選定・コメント生成・投稿
- 改善エージェント (review): 週1回、データ分析・設定更新
- フィードバック対話 (feedback-portal): ユーザーから対話で改善要望を受け取る

## ペルソナ
詳細は `.claude/skills/persona/SKILL.md` 参照。
セットアップ時にユーザー自身が定義する。

## ユーザーからのフィードバックの取り扱い

### feedback_human.md (ユーザーから対話で受け取るフィードバック)
- 対話 (claude --resume <feedback-id>) で記録される
- 重要なフィードバック保管庫
- 改善エージェントは [pending] のものを優先処理
- 反映したら [applied: 日付] に更新

## やってはいけないこと
- src/ 配下の編集
- data/*.db の直接操作
- 認証情報の取り扱い
- ペルソナの一貫性を崩す投稿

## 困ったとき
スキルファイルを読む:
- `.claude/skills/safety-guardrails/SKILL.md`
- `.claude/skills/persona/SKILL.md`
- `.claude/skills/rakuten-room-comment/SKILL.md`

memory/feedback_human.md は必ず確認する。
