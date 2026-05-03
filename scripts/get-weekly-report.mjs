#!/usr/bin/env node
import db from '../src/db.mjs';

const row = db.prepare('SELECT * FROM weekly_reports ORDER BY week_start DESC LIMIT 1').get();
if (!row) {
  process.stdout.write(JSON.stringify({ error: 'no_weekly_report' }) + '\n');
  process.exit(1);
}

const report = row.report_json ? JSON.parse(row.report_json) : null;
const strategy = row.strategy_json ? JSON.parse(row.strategy_json) : null;

process.stdout.write(JSON.stringify({
  week_start: row.week_start,
  created_at: row.created_at,
  report,
  strategy,
}, null, 2) + '\n');
