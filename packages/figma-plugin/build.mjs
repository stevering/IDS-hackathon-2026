/**
 * Build Guardian Plugin (standalone)
 * Utilise esbuild pour bundler code.ts + bridge.ts → dist/code.js
 */

import * as esbuild from 'esbuild';
import { mkdirSync } from 'fs';

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

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('[Guardian Plugin] Watching for changes… (dist/code.js)');
} else {
  await esbuild.build(buildOptions);
  console.log('[Guardian Plugin] Build complete → dist/code.js');
}
