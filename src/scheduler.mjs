/**
 * Scheduler daemon — wall-clock-based, child-process-isolated.
 *
 * Polls every 60s and decides what to run based on wall-clock time.
 * Spawns each job as an independent child process. Tracks per-job
 * last-run dates to avoid duplicate execution and supports startup
 * catch-up for jobs missed while the scheduler was down.
 *
 * In the distribution version, this scheduler is launched by macOS
 * launchd, which provides automatic restart on crash and on Mac boot.
 */
import { spawn } from 'child_process';
import { config } from './config.mjs';
import { getTodayPostCount } from './db.mjs';
import fs from 'fs';
import path from 'path';

const STATUS_FILE = path.join(config.rootDir, 'data', 'scheduler-status.json');
const LOG_PREFIX = '[scheduler]';

function log(msg) {
  console.log(`${LOG_PREFIX} ${new Date().toISOString()} ${msg}`);
}

function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { return {}; }
}

function writeStatus(data) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
}

function updateStatus(updater) {
  const data = readStatus();
  updater(data);
  data.lastHeartbeat = new Date().toISOString();
  writeStatus(data);
}

function getJobs() {
  return [
    {
      key: 'post-morning',
      label: 'Post 09:00 朝',
      cmd: ['post', '--count', String(config.schedule.postCounts[0])],
      due: (jstH, jstM) => jstH === 9 && jstM === 0,
      catchUpUntil: (jstH, jstM, jstDow) => jstH < 12,
      statusKey: 'post',
    },
    {
      key: 'post-noon',
      label: 'Post 12:30 昼',
      cmd: ['post', '--count', String(config.schedule.postCounts[1])],
      due: (jstH, jstM) => jstH === 12 && jstM === 30,
      catchUpUntil: (jstH, jstM, jstDow) => jstH < 18,
      statusKey: 'post',
    },
    {
      key: 'post-night',
      label: 'Post 20:00 夜',
      cmd: ['post', '--count', String(config.schedule.postCounts[2])],
      due: (jstH, jstM) => jstH === 20 && jstM === 0,
      catchUpUntil: (jstH, jstM, jstDow) => jstH < 23,
      statusKey: 'post',
    },
    {
      key: 'collect',
      label: 'Collect 21:00',
      cmd: ['collect'],
      due: (jstH, jstM) => jstH === 21 && jstM === 0,
      catchUpUntil: (jstH, jstM, jstDow) => jstH < 23 || jstH < 4,
      statusKey: 'collect',
    },
    {
      key: 'engage',
      label: 'Engage 22:00',
      cmd: ['engage'],
      due: (jstH, jstM) => jstH === 22 && jstM === 0,
      catchUpUntil: (jstH, jstM, jstDow) => jstH < 23,
      statusKey: 'engage',
    },
    {
      key: 'analyze',
      label: 'Analyze (Sat 06:00)',
      cmd: ['analyze'],
      due: (jstH, jstM, jstDow) => jstDow === 6 && jstH === 6 && jstM === 0,
      catchUpUntil: (jstH, jstM, jstDow) => jstDow === 6,
      statusKey: 'analyze',
      isWeekly: true,
    },
  ];
}

function toJST(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
    dow: jst.getUTCDay(),
    dateStr: jst.toISOString().split('T')[0],
  };
}

function spawnJob(job) {
  log(`Spawning: ${job.label} → node src/cli.mjs ${job.cmd.join(' ')}`);

  const child = spawn('node', ['src/cli.mjs', ...job.cmd], {
    cwd: config.rootDir,
    stdio: 'inherit',
    detached: false,
  });

  updateStatus(data => {
    data[job.statusKey] = {
      status: 'running',
      detail: job.label,
      timestamp: new Date().toISOString(),
      pid: child.pid,
    };
    if (!data.jobs) data.jobs = {};
    data.jobs[job.key] = {
      lastRunAt: new Date().toISOString(),
      lastRunDate: toJST(new Date()).dateStr,
      pid: child.pid,
      status: 'running',
    };
  });

  child.on('exit', (code) => {
    const success = code === 0;
    log(`${job.label} exited with code ${code}`);
    updateStatus(data => {
      data[job.statusKey] = {
        status: success ? 'success' : 'failed',
        detail: `${job.label} exited ${code}`,
        timestamp: new Date().toISOString(),
      };
      if (data.jobs?.[job.key]) {
        data.jobs[job.key].status = success ? 'success' : 'failed';
        data.jobs[job.key].finishedAt = new Date().toISOString();
        data.jobs[job.key].exitCode = code;
      }
    });
  });

  child.on('error', (err) => {
    log(`${job.label} spawn error: ${err.message}`);
    updateStatus(data => {
      data[job.statusKey] = {
        status: 'failed',
        detail: `spawn error: ${err.message}`,
        timestamp: new Date().toISOString(),
      };
    });
  });
}

function alreadyRanToday(job, status) {
  const todayJst = toJST(new Date()).dateStr;
  return status.jobs?.[job.key]?.lastRunDate === todayJst;
}

function tick() {
  updateStatus(d => { d.lastTick = new Date().toISOString(); });

  const now = new Date();
  const jst = toJST(now);
  const status = readStatus();

  for (const job of getJobs()) {
    if (alreadyRanToday(job, status)) continue;

    if (job.due(jst.hour, jst.minute, jst.dow)) {
      spawnJob(job);
      continue;
    }

    if (job.catchUpUntil(jst.hour, jst.minute, jst.dow)) {
      const dueT = getDueHourMin(job);
      if (jst.hour > dueT.h || (jst.hour === dueT.h && jst.minute > dueT.m)) {
        log(`Catch-up: ${job.label} missed at JST ${dueT.h}:${String(dueT.m).padStart(2, '0')}, running now`);
        spawnJob(job);
      }
    }
  }
}

function getDueHourMin(job) {
  // weekly job の場合、dow=6 (土曜) で判定。
  // daily job の場合、due 関数は dow を見ないので任意の値で OK。
  const testDow = job.isWeekly ? 6 : 0;
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      if (job.due(h, m, testDow)) return { h, m };
    }
  }
  return { h: 0, m: 0 };
}

export function startScheduler() {
  log('Starting scheduler (wall-clock based, child-process isolated)');
  log('Schedules:');
  for (const job of getJobs()) {
    log(`  ${job.label}`);
  }

  updateStatus(data => {
    data.scheduler = { status: 'started', detail: '', timestamp: new Date().toISOString() };
  });

  tick();
  setInterval(tick, 60_000);
  log('Scheduler running. Polling every 60s.');

  process.on('SIGINT', () => { log('Shutting down...'); process.exit(0); });
  process.on('SIGTERM', () => { log('Shutting down...'); process.exit(0); });
}

export function checkHealth() {
  const status = readStatus();
  const now = new Date();
  const jst = toJST(now);
  const issues = [];

  if (status.lastTick) {
    const lastTick = new Date(status.lastTick);
    const minutesAgo = (now - lastTick) / 60000;
    if (minutesAgo > 5) {
      issues.push(`Scheduler tick stale (${Math.round(minutesAgo)} min ago)`);
    }
  } else if (status.lastHeartbeat) {
    const lastBeat = new Date(status.lastHeartbeat);
    const minutesAgo = (now - lastBeat) / 60000;
    if (minutesAgo > 30) {
      issues.push(`Heartbeat stale (${Math.round(minutesAgo)} min ago)`);
    }
  } else {
    issues.push('No heartbeat recorded');
  }

  const todayJst = jst.dateStr;
  for (const job of getJobs()) {
    if (job.isWeekly) continue;
    const dueT = getDueHourMin(job);
    const isPast = jst.hour > dueT.h || (jst.hour === dueT.h && jst.minute >= dueT.m + 5);
    if (!isPast) continue;
    if (!job.catchUpUntil(jst.hour)) continue;

    const lastRun = status.jobs?.[job.key]?.lastRunDate;
    if (lastRun !== todayJst) {
      issues.push(`Missed: ${job.label} (last ran ${lastRun || 'never'})`);
    }
  }

  if (status.post?.status === 'failed') {
    issues.push(`Last post failed: ${status.post.detail}`);
  }

  const todayPosts = getTodayPostCount();
  return { healthy: issues.length === 0, issues, status, todayPosts };
}
