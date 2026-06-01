#!/usr/bin/env node
/**
 * Agent wrapper for two AI coding agents:
 *   - Claude Code (`claude -p`, headless) — default
 *   - Codex CLI    (`codex exec`)         — opt-in via AGENT_TYPE=codex
 *
 * Roles:
 *   post   — generate comments + post a batch (kill timer 90 min)
 *   review — weekly improvement: edit Skills/tuning, smoke, commit, merge (20 min)
 *   smoke  — connectivity check (2 min)
 *
 * AGENT_TYPE selection (read from process.env, optional):
 *   unset / "claude" → use Claude Code (existing behavior, default)
 *   "codex"          → use Codex CLI (experimental; reference-only support)
 *
 * Subscription auth (Claude Code path):
 *   ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN are stripped from the spawned env.
 *   `claude --version` must succeed (Claude Code 2.x uses macOS Keychain).
 *
 * Subscription auth (Codex path):
 *   OPENAI_API_KEY must be set (env or .env), OR ChatGPT sign-in completed.
 *   `codex --version` must succeed.
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
    model: 'claude-opus-4-6',
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

/* ===================================================================
 * Claude Code path (default, production-tested)
 * =================================================================== */
function assertClaudeAuth() {
  try {
    execSync('claude --version', {
      stdio: 'ignore',
      timeout: 10_000,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    console.error(`[agent] FATAL: 'claude' command not available or not authenticated.`);
    console.error(`[agent]   Please ensure Claude Code is installed and you have logged in:`);
    console.error(`[agent]     npm install -g @anthropic-ai/claude-code`);
    console.error(`[agent]     claude  (and complete the sign-in flow)`);
    process.exit(2);
  }
}

function spawnClaude(role, cfg, promptText, logStream, logPath, extraArgs) {
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
  if (cfg.model) args.push('--model', cfg.model);
  if (cfg.verbose) args.push('--verbose');

  const child = spawn('claude', args, {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
    // Windows では claude が claude.cmd / claude.ps1 のシムで提供されることがあり、
    // shell: true を経由しないと spawn ENOENT になる。Mac/Linux では影響なし。
    shell: process.platform === 'win32',
  });

  child.stdin.write(promptText);
  child.stdin.end();

  child.stdout.on('data', chunk => {
    logStream.write(chunk);
    process.stdout.write(chunk);
  });

  return child;
}

/* ===================================================================
 * Codex CLI path (experimental, reference-only, opt-in)
 *
 * IMPORTANT: This path is NOT production-tested. Behavior may differ
 * significantly from Claude Code due to:
 *   - Different output format (Codex emits JSONL, not stream-json)
 *   - Different sandbox model (--sandbox workspace-write needed for writes)
 *   - Different model characteristics (GPT-5 vs Claude Opus 4.x)
 *   - Skills resolved from ~/.agents/skills/ instead of .claude/skills/
 *     (mitigated by duplicating skills into .agents/skills/ in the repo)
 * =================================================================== */
function assertCodexAuth() {
  try {
    execSync('codex --version', {
      stdio: 'ignore',
      timeout: 10_000,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    console.error(`[agent] FATAL: 'codex' command not available.`);
    console.error(`[agent]   Please ensure Codex CLI is installed:`);
    console.error(`[agent]     npm install -g @openai/codex`);
    console.error(`[agent]   And complete one of the auth methods:`);
    console.error(`[agent]     a) Set OPENAI_API_KEY in .env`);
    console.error(`[agent]     b) Run 'codex' once and sign in with ChatGPT`);
    process.exit(2);
  }

  // Hint when neither OPENAI_API_KEY nor ChatGPT sign-in seems present.
  // We can't reliably check ChatGPT sign-in state, so this is best-effort.
  if (!process.env.OPENAI_API_KEY) {
    console.error(`[agent] NOTE: OPENAI_API_KEY is not set. Assuming ChatGPT sign-in is configured.`);
    console.error(`[agent]       If Codex fails with an auth error, run 'codex' once interactively to sign in.`);
  }
}

function spawnCodex(role, cfg, promptText, logStream, logPath, extraArgs) {
  const env = { ...process.env };
  env.AGENT_ROLE = role;
  env.AGENT_ARGS = extraArgs.join(' ');
  env.AGENT_LOG_PATH = logPath;

  // Codex CLI fragment.
  // - `exec` runs non-interactively
  // - `--json` emits machine-readable JSONL on stdout
  // - `--cd` sets working directory (analogous to --add-dir)
  // - `--ask-for-approval never` skips prompts (analogous to permissionMode acceptEdits)
  // - `--sandbox workspace-write` allows file writes in cwd (mandatory for edits)
  //   For smoke role, read-only is sufficient.
  // - `--skip-git-repo-check` because the repo's working state may be dirty
  const sandbox = (cfg.allowedTools.includes('Write') || cfg.allowedTools.includes('Edit'))
    ? 'workspace-write'
    : 'read-only';

  const args = [
    'exec',
    '--json',
    '--cd', ROOT,
    '--ask-for-approval', 'never',
    '--sandbox', sandbox,
    '--skip-git-repo-check',
  ];
  // Optional model selection. Codex defaults work; user can override via CODEX_MODEL.
  const codexModel = process.env.CODEX_MODEL;
  if (codexModel) {
    args.push('--model', codexModel);
  }

  const child = spawn('codex', args, {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
    // Windows では codex が codex.cmd / codex.ps1 のシムで提供されることがあり、
    // shell: true を経由しないと spawn ENOENT になる。Mac/Linux では影響なし。
    shell: process.platform === 'win32',
  });

  child.stdin.write(promptText);
  child.stdin.end();

  child.stdout.on('data', chunk => {
    logStream.write(chunk);
    process.stdout.write(chunk);
  });

  return child;
}

/* ===================================================================
 * Common scaffolding (auth + review lock + main entry)
 * =================================================================== */
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

function getAgentType() {
  const raw = (process.env.AGENT_TYPE || 'claude').toLowerCase();
  if (raw !== 'claude' && raw !== 'codex') {
    console.error(`[agent] FATAL: Unknown AGENT_TYPE='${raw}'. Must be 'claude' (default) or 'codex'.`);
    process.exit(1);
  }
  return raw;
}

async function main() {
  const role = process.argv[2];
  const extraArgs = process.argv.slice(3);

  if (!role || !ROLE_CONFIG[role]) {
    console.error(`Usage: node scripts/agent.mjs <post|review|smoke> [args...]`);
    process.exit(1);
  }

  const agentType = getAgentType();

  // Auth check per agent type
  if (agentType === 'codex') {
    assertCodexAuth();
  } else {
    assertClaudeAuth();
  }

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
  // ログファイル名は AGENT_TYPE='claude' (デフォルト) では従来通り <role>-<ts>.jsonl を維持。
  // Codex を使う場合のみ <role>-codex-<ts>.jsonl で区別できるようにする。
  const logFileBase = agentType === 'claude' ? role : `${role}-${agentType}`;
  const logPath = path.join(logsDir, `${logFileBase}-${ts}.jsonl`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const promptText = fs.readFileSync(promptPath, 'utf-8')
    + `\n\n## Runtime context\n- AGENT_TYPE: ${agentType}\n- AGENT_ROLE: ${role}\n- AGENT_ARGS: ${extraArgs.join(' ')}\n- AGENT_LOG_PATH: ${logPath}\n`;

  console.error(`[agent] type=${agentType} role=${role} log=${logPath} kill=${cfg.killMs / 60000}min`);

  // Dispatch to per-agent spawner
  const child = (agentType === 'codex')
    ? spawnCodex(role, cfg, promptText, logStream, logPath, extraArgs)
    : spawnClaude(role, cfg, promptText, logStream, logPath, extraArgs);

  const killTimer = setTimeout(() => {
    console.error(`[agent] kill timer (${cfg.killMs / 60000}min) reached, sending SIGTERM`);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10_000);
  }, cfg.killMs);

  child.on('exit', (code, signal) => {
    clearTimeout(killTimer);
    logStream.end();
    console.error(`[agent] type=${agentType} role=${role} exit code=${code} signal=${signal || ''}`);
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
