# 楽天ROOM 自動投稿システム セットアップガイド

このシステムを Mac で動かすための手順書です。
ターミナル操作に慣れていなくても、コマンドをコピペしながら進められるように書いています。

**所要時間**: 30〜60分（待ち時間含む）

---

## 目次

- [前提・準備](#前提準備)
- [1. ツール類のインストール](#1-ツール類のインストール)
- [2. プロジェクトの配置](#2-プロジェクトの配置)
- [3. 環境変数の設定](#3-環境変数の設定)
- [4. ペルソナを設計する](#4-ペルソナを設計する)
- [5. 初期データの投入](#5-初期データの投入)
- [6. 動作確認](#6-動作確認)
- [7. 自動起動の設定（最重要）](#7-自動起動の設定最重要)
- [8. 日常運用](#8-日常運用)
- [トラブルシューティング](#トラブルシューティング)

---

## 前提・準備

### 必要なもの

- Mac（macOS、Apple Silicon または Intel どちらでも）
- 楽天会員アカウント（ROOMで活動するメインアカウント）
- 楽天アフィリエイトの登録（無料）
- 楽天ウェブサービスの登録（無料）
- Claude Pro または Max のサブスク契約（**必須・月額 $20〜**）

### このガイドで使うコマンドの基本

ターミナル（Mac標準アプリ）を使います。`Spotlight検索（Cmd+Space）→ "ターミナル"` で開けます。

ターミナル操作で覚えてほしいのは2つだけ:
- **コピペ → Enter**: コマンドを実行
- **Ctrl+C**: 実行中のコマンドを中止

---

## 1. ツール類のインストール

### 1-1. Homebrew（パッケージマネージャ）

ターミナルを開いて、以下のコマンドを丸ごとコピペ → Enter:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

途中でパスワードを聞かれたら Mac のログインパスワードを入力（画面には何も表示されないが入力されています）。

完了後、画面に表示される **「Next steps」のコマンド2行**を順番にコピペして実行（Apple Silicon の場合）。

確認:
```bash
brew --version
```
バージョン番号が出ればOK。

### 1-2. Node.js

```bash
brew install node@20
```

PATH を通す（Apple Silicon の場合）:
```bash
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

確認:
```bash
node --version
```
`v20.x.x` のように表示されれば OK。

### 1-3. Git

```bash
brew install git
git --version
```

### 1-4. Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

サブスク契約でログイン:
```bash
claude login
```

ブラウザが開くので、Pro または Max プランの Anthropic アカウントでログインします。

### 1-5. Visual Studio Code（任意）

ファイル編集が楽になるので入れておくのがおすすめ:
```bash
brew install --cask visual-studio-code
```

---

## 2. プロジェクトの配置

### 2-1. プロジェクト用フォルダを作る

```bash
mkdir -p ~/projects
cd ~/projects
```

### 2-2. このシステムを配置する

購入時にダウンロードした ZIP（または GitHub からクローン）を `~/projects/rakuten-room` として配置します。

ZIP を解凍した場合は、解凍されたフォルダ名を `rakuten-room` に変更して `~/projects` の下に置いてください。

```bash
cd ~/projects/rakuten-room
ls
```

`README.md`、`package.json`、`src/` などが見えれば OK。

### 2-3. 依存パッケージをインストール

```bash
npm install
npx playwright install chromium
```

インストールに数分かかります。

---

## 3. 環境変数の設定

### 3-1. .env ファイルを作成

```bash
cp .env.example .env
```

### 3-2. 楽天ウェブサービスのキーを取得

[楽天ウェブサービス](https://webservice.rakuten.co.jp/) でアプリを登録します。

1. ログイン → 「アプリ ID 発行」
2. アプリ名を入力（任意、例: `room-auto-poster`）
3. アプリ URL（任意、`http://localhost` で OK）
4. 発行された **アプリ ID** と **アプリケーションシークレット（access key）** を控える
5. **アフィリエイト ID** も同じページに表示されているので控える

### 3-3. .env を編集

```bash
open -e .env
```

開いたファイルに、以下の値を入れます:

```bash
RAKUTEN_EMAIL=楽天会員のメアド
RAKUTEN_PASSWORD=楽天会員のパスワード
ROOM_USER_ID=room.rakuten.co.jp/<ここ> の部分
RAKUTEN_APP_ID=さっき取得したアプリID
RAKUTEN_ACCESS_KEY=さっき取得したaccess key
RAKUTEN_AFFILIATE_ID=アフィリエイトID
```

> **ROOM_USER_ID の確認方法**: 自分の ROOM プロフィールページのURLを見ると、
> `https://room.rakuten.co.jp/your_id_here/items` のような形式になっています。
> その `your_id_here` の部分が ROOM_USER_ID です。

保存して閉じます（Cmd+S → Cmd+W）。

---

## 4. ペルソナを設計する

ここがこのシステムの心臓部です。Claude Code はあなたが定義したペルソナになりきってコメントを書きます。

### 4-1. 完成サンプルを見る

`EXAMPLES/persona-yuuki.md` を開いて、サンプルペルソナ「ゆうき⚡」がどう書かれているか見てみてください。

```bash
open -e EXAMPLES/persona-yuuki.md
```

### 4-2. ペルソナファイルを編集

```bash
open -e .claude/skills/persona/SKILL.md
```

`<...>` で囲まれたプレースホルダを、自分のペルソナで埋めてください。

#### 検討ポイント

| 項目 | 例 |
|------|-----|
| キャラ名 | `みお🌸`、`けんと⚡`、`さおり☕`など、絵文字付きが分かりやすい |
| 年齢層・性別 | 30代女性、40代男性、など |
| 家族構成・職業 | 一人暮らし会社員、共働き子育て中、など |
| 関心 | 3〜5個のキーワード |
| 性格 | 3語で表現 |
| 一人称 | 私／僕／うち／自分 など |
| 文末絵文字 | ペルソナのトーンに合うもの3〜5個 |

### 4-3. コメントのシード例を書き換える

```bash
open -e .claude/skills/rakuten-room-comment/SKILL.md
```

ファイル末尾の `Seed examples` セクションを編集します。
`EXAMPLES/seeds-yuuki.md` を参考に、自分のペルソナの口調で **最低3件、できれば8件** 書いてください。

> ⚠️ **重要**: シード例の質がコメント生成の質を決めます。手抜きせずに書いてください。

### 4-4. （任意）サンプル EXAMPLES の削除

最終的にあなたのペルソナで動いているなら、混乱を避けるために `EXAMPLES/` フォルダは消してしまっても問題ありません。

```bash
rm -rf EXAMPLES
```

---

## 5. 初期データの投入

```bash
npm run init-genres
npm run init-keywords
```

それぞれ数秒で完了します。これで楽天ジャンルプールとキーワードプールが初期化されました。

---

## 6. 動作確認

### 6-1. 接続テスト

```bash
npm run smoke
```

最後に `{"smoke":"ok",...}` のような JSON が出れば成功。

### 6-2. 商品取得テスト

```bash
node scripts/get-products.mjs --count 3
```

3件の商品が JSON で出力されれば OK。

### 6-3. （任意）試しに1回だけ投稿してみる

> ⚠️ 実際にあなたの楽天ROOMに投稿されます。テスト後に消すかどうかは自由。

```bash
node src/cli.mjs post --count 1
```

数分待つと1件投稿されます。完了後 ROOM のマイページを開いて投稿を確認してください。

### 6-4. ステータス確認

```bash
npm run status
```

DB の中身、商品数、投稿数、戦略などが見られます。

---

## 7. 自動起動の設定（最重要）

ここが配布版の目玉機能です。**Mac を起動するだけで、裏で自動投稿が動き続ける**ように設定します。

### 7-1. launchd への登録

ターミナルで以下を実行（コピペで一発）:

```bash
bash launchd/install-launchd.sh
```

これだけで以下が完了します:
- Mac 起動時に scheduler が自動起動
- scheduler が万が一落ちても自動再起動
- 全ての出力がログファイルに記録される

### 7-2. 動作確認

scheduler が動いているか確認:
```bash
launchctl list | grep rakuten-room
```

PID（数値）が表示されれば動作中です。

ログをリアルタイムに見る:
```bash
tail -f launchd/scheduler.log
```

`[scheduler] ... Starting scheduler` のような行が見えれば OK。
ターミナルを抜けるには `Ctrl+C`（scheduler は止まりません）。

### 7-3. これで完了

以降、あなたが何もしなくても:
- 朝9:00 / 昼12:30 / 夜20:00 に自動投稿
- 夜21:00 にアフィリエイトレポート収集
- 夜22:00 に likes & follows 実行
- 土曜朝6:00 に週次改善

が自動で動き続けます。Mac を再起動しても自動で復旧します。

---

## 8. 日常運用

### 8-1. ステータスを見たいとき

```bash
cd ~/projects/rakuten-room
npm run status
```

### 8-2. ログを見たいとき

```bash
cd ~/projects/rakuten-room
tail -f launchd/scheduler.log
```

### 8-3. ペルソナや設定を変えたいとき

ファイルを編集すれば即時反映されます（次の投稿から反映）:
- ペルソナ: `.claude/skills/persona/SKILL.md`
- コメントルール: `.claude/skills/rakuten-room-comment/SKILL.md`
- ハッシュタグ: `.claude/skills/hashtag-strategy/SKILL.md`

### 8-4. フィードバック対話

「もっと〇〇な感じにしてほしい」を Claude Code に伝える専用インターフェースがあります:

```bash
cd ~/projects/rakuten-room
claude --skill feedback-portal
```

対話形式で要望を伝えると、`memory/feedback_human.md` に記録され、次回の週次改善で反映されます。

### 8-5. 一時的に止めたいとき

```bash
launchctl unload ~/Library/LaunchAgents/com.rakuten-room.scheduler.plist
```

再開:
```bash
launchctl load ~/Library/LaunchAgents/com.rakuten-room.scheduler.plist
```

### 8-6. 完全にアンインストール

```bash
launchctl unload ~/Library/LaunchAgents/com.rakuten-room.scheduler.plist
rm ~/Library/LaunchAgents/com.rakuten-room.scheduler.plist
rm -rf ~/projects/rakuten-room
```

---

## トラブルシューティング

### scheduler が起動していない

```bash
# ログを確認
tail -50 ~/projects/rakuten-room/launchd/scheduler-error.log

# 再登録
bash ~/projects/rakuten-room/launchd/install-launchd.sh
```

### 投稿が失敗する

ログイン情報や API キーが間違っている可能性があります:
```bash
cd ~/projects/rakuten-room
open -e .env
```
内容を確認して保存し直してください。

### コメントの質がイマイチ

ペルソナのシード例が少ない or 抽象的すぎる可能性があります。
`.claude/skills/rakuten-room-comment/SKILL.md` のシード例を、より具体的な実例で書き直してみてください。

### Claude Code でエラーが出る

サブスクの契約状態を確認:
```bash
claude login
```

### それでも解決しない

Note の購入記事のコメント欄に状況を書いてください。

エラーメッセージを貼ってもらえると対応が早いです。
