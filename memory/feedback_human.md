# Human Feedback Log

ユーザーから対話で受け取ったフィードバックの記録。
改善エージェントが週次レビュー時に [pending] を優先処理する。

## フォーマット

```
## [日付] [優先度] [カテゴリ] [pending]
具体的な改善内容。
背景・理由も1〜2行で補足する。
```

優先度: high / medium / low
カテゴリ: comment / product / hashtag / persona / schedule / other
状態: pending → applied: <日付> に更新

---

## [YYYY-MM-DD] [low] [other] [applied: YYYY-MM-DD]
セットアップ完了。
