import * as esbuild from 'esbuild';
import { mkdirSync } from 'fs';

const isWatch = process.argv.includes('--watch');

mkdirSync('dist', { recursive: true });

const buildOptions = {
  entryPoints: ['widget-src/code.tsx'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es6',
  jsxFactory: 'widget.h',
  jsxFragment: 'widget.Fragment',
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('[Guardian Widget] Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('[Guardian Widget] Build complete → dist/code.js');
}
