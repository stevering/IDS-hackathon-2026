/**
 * Build Guardian Plugin (standalone)
 * Utilise esbuild pour bundler code.ts + bridge.ts → dist/code.js
 */

import * as esbuild from 'esbuild';

console.log('[Guardian Plugin] Bundling (esbuild)…');
await esbuild.build({
  entryPoints: ['code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es6',
  platform: 'browser',
  logLevel: 'silent',
});
console.log('[Guardian Plugin] Build complete → dist/code.js');
