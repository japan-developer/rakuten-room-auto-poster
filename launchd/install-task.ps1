# =============================================================================
# Windows Task Scheduler セットアップスクリプト
#
# このスクリプトは scheduler を Windows 起動時に自動起動するよう登録します。
# 一度実行すれば、以降は PC を起動するだけで scheduler が裏で動き続けます。
#
# 使い方 (PowerShell 7 で実行):
#   .\launchd\install-task.ps1
#
# または PowerShell 5.1 互換 (Windows 11 標準) でも動作するように書かれています。
#
# 注意:
# - 管理者権限は不要です(Userレベルのタスクとして登録します)
# - 既存のタスクがあれば自動的に再登録します
# =============================================================================

$ErrorActionPreference = "Stop"

# スクリプトのあるディレクトリ → プロジェクトルート
$ScriptDir = $PSScriptRoot
$ProjectPath = Split-Path -Parent $ScriptDir
$TaskName = "RakutenRoomScheduler"

Write-Host "=========================================="
Write-Host "  Task Scheduler セットアップ"
Write-Host "=========================================="
Write-Host ""
Write-Host "プロジェクトパス: $ProjectPath"
Write-Host "ユーザーホーム: $HOME"
Write-Host ""

# ----- Node.js のパスを検出 -----
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
    Write-Host "❌ エラー: node コマンドが見つかりません。" -ForegroundColor Red
    Write-Host "   Node.js をインストールしてからもう一度実行してください。"
    Write-Host "   推奨: winget install OpenJS.NodeJS.LTS"
    exit 1
}
Write-Host "Node.js: $NodePath"
Write-Host ""

# ----- ログディレクトリの準備 -----
$LogDir = Join-Path $ProjectPath "launchd"
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
$StdOutLog = Join-Path $LogDir "scheduler.log"
$StdErrLog = Join-Path $LogDir "scheduler-error.log"

# ----- 既存のタスクがあれば削除 -----
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
    Write-Host "既存の Task Scheduler 設定を解除します..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# ----- タスクの定義 -----
# scheduler は node src/cli.mjs scheduler として起動する常駐プロセス。
# 起動時に走らせ、落ちたら自動再起動させる。

$CliPath = Join-Path $ProjectPath "src\cli.mjs"

# 標準出力・エラーをファイルにリダイレクトするため、cmd /c でラップ
# (PowerShell Start-Process はリダイレクトが安定しない場合があるため)
$WrappedCommand = "`"$NodePath`" `"$CliPath`" scheduler >> `"$StdOutLog`" 2>> `"$StdErrLog`""

$Action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c $WrappedCommand" `
    -WorkingDirectory $ProjectPath

# トリガー: ログオン時に起動
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# 落ちたときの再起動設定
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([System.TimeSpan]::Zero)  # タイムアウトなし(常駐用)

# 実行ユーザー: 現在のユーザーで対話セッションを使う(LimitedToken なしで実行)
$Principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

# ----- タスクを登録 -----
Write-Host "Task Scheduler に登録します..."
Write-Host "  タスク名: $TaskName"

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Rakuten ROOM Auto Poster - scheduler 常駐プロセス" | Out-Null

# 登録後、すぐに起動
Write-Host "scheduler をすぐに起動します..."
Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "✅ セットアップ完了" -ForegroundColor Green
Write-Host ""
Write-Host "=========================================="
Write-Host "  動作確認"
Write-Host "=========================================="
Write-Host ""
Write-Host "scheduler が起動しているか確認:"
Write-Host "  Get-ScheduledTask -TaskName $TaskName"
Write-Host ""
Write-Host "ログを確認:"
Write-Host "  Get-Content -Wait $StdOutLog"
Write-Host "  Get-Content -Wait $StdErrLog"
Write-Host ""
Write-Host "停止:"
Write-Host "  Stop-ScheduledTask -TaskName $TaskName"
Write-Host ""
Write-Host "再起動:"
Write-Host "  Stop-ScheduledTask -TaskName $TaskName"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host ""
Write-Host "完全に削除:"
Write-Host "  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host ""
