# Smoke Test

接続性とコンテキストを確認するだけ。2 分以内。

## やること

1. `safety-guardrails` Skill を Read する
2. 以下のファイルが存在することを Read で確認:
   - `data/runtime-tuning.json`
   - `.claude/skills/persona/SKILL.md`
   - `.claude/skills/rakuten-room-comment/SKILL.md`
   - `prompts/agent-post.md`
   - `prompts/agent-review.md`
3. 何も書き換えない
4. 最後に 1 行 JSON で報告:

```json
{"smoke": "ok", "skill_files": <count>, "tuning_present": true}
```

## 失敗時

ファイルが存在しなければ:

```json
{"smoke": "fail", "missing": ["<path>"]}
```

## 重要

- Edit / Write は禁止 (Read のみ)
- Bash も禁止
- 2 分以内に終わる
