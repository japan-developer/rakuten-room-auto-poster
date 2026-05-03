#!/bin/bash
# =============================================================================
# launchd セットアップスクリプト
#
# このスクリプトは scheduler を Mac 起動時に自動起動するよう登録します。
# 一度実行すれば、以降は Mac を起動するだけで scheduler が裏で動き続けます。
#
# 使い方:
#   bash launchd/install-launchd.sh
# =============================================================================

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_PATH="$( cd "$SCRIPT_DIR/.." && pwd )"
PLIST_NAME="com.rakuten-room.scheduler.plist"
PLIST_SOURCE="$SCRIPT_DIR/$PLIST_NAME"
PLIST_TARGET="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "=========================================="
echo "  launchd セットアップ"
echo "=========================================="
echo ""
echo "プロジェクトパス: $PROJECT_PATH"
echo "ホームディレクトリ: $HOME"
echo ""

# Node.js のパスを検出
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    echo "❌ エラー: node コマンドが見つかりません。"
    echo "   Node.js をインストールしてからもう一度実行してください。"
    exit 1
fi
echo "Node.js: $NODE_PATH"
echo ""

# 既存の登録があれば一旦解除
if [ -f "$PLIST_TARGET" ]; then
    echo "既存の launchd 設定を解除します..."
    launchctl unload "$PLIST_TARGET" 2>/dev/null || true
    rm "$PLIST_TARGET"
fi

# LaunchAgents ディレクトリを作成
mkdir -p "$HOME/Library/LaunchAgents"

# テンプレートのプレースホルダを置換してコピー
echo "plist ファイルを作成します..."
sed -e "s|__PROJECT_PATH__|$PROJECT_PATH|g" \
    -e "s|__HOME_PATH__|$HOME|g" \
    -e "s|__NODE_PATH__|$NODE_PATH|g" \
    "$PLIST_SOURCE" > "$PLIST_TARGET"

echo "  → $PLIST_TARGET"
echo ""

# launchd に登録
echo "launchd に登録します..."
launchctl load "$PLIST_TARGET"

echo ""
echo "✅ セットアップ完了"
echo ""
echo "=========================================="
echo "  動作確認"
echo "=========================================="
echo ""
echo "scheduler が起動しているか確認:"
echo "  launchctl list | grep rakuten-room"
echo ""
echo "ログを確認:"
echo "  tail -f $PROJECT_PATH/launchd/scheduler.log"
echo "  tail -f $PROJECT_PATH/launchd/scheduler-error.log"
echo ""
echo "停止:"
echo "  launchctl unload $PLIST_TARGET"
echo ""
echo "再起動:"
echo "  launchctl unload $PLIST_TARGET && launchctl load $PLIST_TARGET"
echo ""
echo "完全に削除:"
echo "  launchctl unload $PLIST_TARGET && rm $PLIST_TARGET"
echo ""
