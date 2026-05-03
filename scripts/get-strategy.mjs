#!/usr/bin/env node
import { getLatestStrategy } from '../src/db.mjs';
import { config } from '../src/config.mjs';

const latest = getLatestStrategy();
if (!latest) {
  process.stdout.write(JSON.stringify({ source: 'default', strategy: config.strategy }, null, 2) + '\n');
  process.exit(0);
}

const strategy = latest.strategy_json ? JSON.parse(latest.strategy_json) : config.strategy;
process.stdout.write(JSON.stringify({
  source: 'weekly_report',
  weekStart: latest.week_start,
  createdAt: latest.created_at,
  strategy,
}, null, 2) + '\n');
