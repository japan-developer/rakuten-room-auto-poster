#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TUNING = path.join(__dirname, '..', 'data', 'runtime-tuning.json');

try {
  const raw = fs.readFileSync(TUNING, 'utf-8');
  process.stdout.write(raw + '\n');
} catch (err) {
  process.stdout.write(JSON.stringify({ error: 'tuning_missing', path: TUNING }) + '\n');
  process.exit(1);
}
