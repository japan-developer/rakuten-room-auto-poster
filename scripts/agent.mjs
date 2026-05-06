#!/usr/bin/env node
/**
 * Thin wrapper around `claude -p` (Claude Code headless) for agent roles.
 *
 * Roles:
 *   post   — generate comments + post a batch (kill timer 90 min)
 *   review — weekly improvement: edit Skills/tuning, smoke, commit, merge (20 min)
 *   smoke  — connectivity check (2 min)
 *
 * Subscription auth is enforced by stripping any ANTHROPIC_API_KEY /
 * ANTHROPIC_AUTH_TOKEN from the spawned env, then verifying that the
 * `claude` binary is available and runnable. Claude Code 2.x stores
 * credentials in macOS Keychain rather than a credentials.json file.
 */
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ROLE_CONFIG = {
  post: {
    promptFile: 'prompts/agent-post.md',
    maxTurns: 40,
    killMs: 90 * 60_000,
    permissionMode: 'acceptEdits',
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    verbose: true,
  },
  review: {
    promptFile: 'prompts/agent-review.md',
    maxTurns: 60,
    killMs: 20 * 60_000,
    permissionMode: 'acceptEdits',
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    verbose: true,
  },
  smoke: {
    promptFile: 'prompts/agent-smoke.md',
    maxTurns: 3,
    killMs: 2 * 60_000,
    permissionMode: 'default',
    allowedTools: ['Read'],
    verbose: true,
  },
};

const STARTS_FILE = path.join(ROOT, 'data', 'agent-starts.json');
const DAILY_START_LIMIT = 5;

function readStarts() {
  try { return JSON.parse(fs.readFileSync(STARTS_FILE, 'utf-8')); } catch { return {}; }
}
function recordStart(role) {
  const data = readStarts();
  const today = new Date().toISOString().slice(0, 10);
  if (!data[today]) data[today] = {};
  data[today][role] = (data[today][role] || 0) + 1;
  const keys = Object.keys(data).sort().slice(-14);
  const trimmed = {};
  for (const k of keys) trimmed[k] = data[k];
  fs.mkdirSync(path.dirname(STARTS_FILE), { recursive: true });
  fs.writeFileSync(STARTS_FILE, JSON.stringify(trimmed, null, 2));
  return data[today][role];
}

function assertSubscriptionAuth() {
  // Claude Code 2.x ではキーチェーンに認証情報が保存されるため、
  // credentials.json の存在確認ではなく claude コマンドの動作確認で代替する。
  // claude --version が成功すれば、Claude Code がインストールされていて
  // 認証ファイル/キーチェーンが利用可能な状態であると判断する。
  try {
    execSync('claude --version', { stdio: 'ignore', timeout: 10_000 });
  } catch (err) {
    console.error(`[agent] FATAL: 'claude' command not available or not authenticated.`);
    console.error(`[agent]   Please ensure Claude Code is installed and you have logged in:`);
    console.error(`[agent]     npm install -g @anthropic-ai/claude-code`);
    console.error(`[agent]     claude  (and complete the sign-in flow)`);
    process.exit(2);
  }
}

function checkReviewLock(role) {
  const lock = path.join(ROOT, 'data', 'agent-review.lock');
  if (role === 'post' && fs.existsSync(lock)) {
    console.error(`[agent] Review agent is running (lock present). Refusing to start post agent.`);
    process.exit(3);
  }
  if (role === 'review') {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      const cleanup = () => { try { fs.unlinkSync(lock); } catch {} };
      process.on('exit', cleanup);
      process.on('SIGINT', () => { cleanup(); process.exit(130); });
      process.on('SIGTERM', () => { cleanup(); process.exit(143); });
    } catch (err) {
      if (err.code === 'EEXIST') {
        console.error(`[agent] Another review agent is already running.`);
        process.exit(3);
      }
      throw err;
    }
  }
}

async function main() {
  const role = process.argv[2];
  const extraArgs = process.argv.slice(3);

  if (!role || !ROLE_CONFIG[role]) {
    console.error(`Usage: node scripts/agent.mjs <post|review|smoke> [args...]`);
    process.exit(1);
  }

  assertSubscriptionAuth();

  const startCount = recordStart(role);
  if (startCount > DAILY_START_LIMIT) {
    console.error(`[agent] Daily start limit exceeded for role=${role} (${startCount}/${DAILY_START_LIMIT}).`);
    process.exit(4);
  }

  checkReviewLock(role);

  const cfg = ROLE_CONFIG[role];
  const promptPath = path.join(ROOT, cfg.promptFile);
  if (!fs.existsSync(promptPath)) {
    console.error(`[agent] prompt file missing: ${promptPath}`);
    process.exit(1);
  }

  const logsDir = path.join(ROOT, 'data', 'agent-logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logsDir, `${role}-${ts}.jsonl`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.AGENT_ROLE = role;
  env.AGENT_ARGS = extraArgs.join(' ');
  env.AGENT_LOG_PATH = logPath;

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--max-turns', String(cfg.maxTurns),
    '--add-dir', ROOT,
    '--permission-mode', cfg.permissionMode,
    '--allowedTools', cfg.allowedTools.join(' '),
    '--tools', cfg.allowedTools.join(','),
    '--strict-mcp-config',
  ];
  if (cfg.verbose) args.push('--verbose');

  const promptText = fs.readFileSync(promptPath, 'utf-8')
    + `\n\n## Runtime context\n- AGENT_ROLE: ${role}\n- AGENT_ARGS: ${env.AGENT_ARGS}\n- AGENT_LOG_PATH: ${logPath}\n`;

  console.error(`[agent] role=${role} log=${logPath} kill=${cfg.killMs / 60000}min`);

  const child = spawn('claude', args, {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  child.stdin.write(promptText);
  child.stdin.end();

  child.stdout.on('data', chunk => {
    logStream.write(chunk);
    process.stdout.write(chunk);
  });

  const killTimer = setTimeout(() => {
    console.error(`[agent] kill timer (${cfg.killMs / 60000}min) reached, sending SIGTERM`);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10_000);
  }, cfg.killMs);

  child.on('exit', (code, signal) => {
    clearTimeout(killTimer);
    logStream.end();
    console.error(`[agent] role=${role} exit code=${code} signal=${signal || ''}`);
    process.exit(code ?? (signal ? 1 : 0));
  });

  child.on('error', err => {
    clearTimeout(killTimer);
    console.error(`[agent] spawn error: ${err.message}`);
    process.exit(1);
  });
}

main().catch(err => {
  console.error(`[agent] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
