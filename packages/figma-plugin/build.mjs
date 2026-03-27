/**
 * Build Guardian Plugin (standalone)
 * Uses esbuild to bundle code.ts + bridge.ts → dist/code.js
 */

import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

const GUARDIAN_URL = process.env.GUARDIAN_URL || 'http://localhost:3000';

mkdirSync('dist', { recursive: true });

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es6',
  platform: 'browser',
  logLevel: 'silent',
};

// Copy ui.html → dist/ui.html with GUARDIAN_URL replacement
function buildUiHtml() {
  const html = readFileSync('ui.html', 'utf8');
  writeFileSync('dist/ui.html', html.replace('__GUARDIAN_URL__', GUARDIAN_URL));
}

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  buildUiHtml();
  console.log(`[Guardian Plugin] Watching for changes… (dist/code.js, GUARDIAN_URL=${GUARDIAN_URL})`);
} else {
  await esbuild.build(buildOptions);
  buildUiHtml();
  console.log(`[Guardian Plugin] Build complete → dist/code.js + dist/ui.html (GUARDIAN_URL=${GUARDIAN_URL})`);
}
