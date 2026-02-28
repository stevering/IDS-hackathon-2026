/**
 * Combined Guardian Widget + Plugin build
 *
 * Produces dist/code.js containing:
 *   - widget code (widget.register → active in widget context)
 *   - plugin code (figma.showUI + handlers → active in plugin context)
 *
 * Plugin code comes from packages/figma-plugin/ (source of truth).
 * Also produces dist/ui.html (copied from figma-plugin/ui.html).
 *
 * Build  : node build.mjs
 * Watch  : node build.mjs --watch
 *   → esbuild watches widget-src/
 *   → tsc --watch watches figma-plugin/code.ts
 *   → any change (widget or plugin) rebuilds dist/code.js
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, watch } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(__dirname, '../figma-plugin');
const isWatch = process.argv.includes('--watch');

mkdirSync('dist', { recursive: true });

// ── Merge function ──────────────────────────────────────────────────────
function merge(widgetCode) {
  const pluginCode = readFileSync(resolve(pluginDir, 'dist/code.js'), 'utf8');
  const merged = `\
// ── Widget (widget.register — no-op in plugin mode) ────────────────────────
${widgetCode}

// ── Plugin (showUI + handlers — only in plugin mode) ──────────────────
if (typeof figma.openPlugin === 'function') {
${pluginCode}
}
`;
  writeFileSync('dist/code.js', merged);
  copyFileSync(resolve(pluginDir, 'ui.html'), 'dist/ui.html');
}

// ── Single build ────────────────────────────────────────────────────────────
if (!isWatch) {
  console.log('[Guardian Widget] Building plugin (esbuild)…');
  execSync('node build.mjs', { stdio: 'inherit', cwd: pluginDir });

  console.log('[Guardian Widget] Compiling widget (esbuild)…');
  const result = await esbuild.build({
    entryPoints: ['widget-src/code.tsx'],
    bundle: true,
    write: false,
    target: 'es6',
    jsxFactory: 'widget.h',
    jsxFragment: 'widget.Fragment',
    logLevel: 'silent',
  });

  merge(result.outputFiles[0].text);
  console.log('[Guardian Widget] Build complete ✓  →  dist/code.js + dist/ui.html');
  process.exit(0);
}

// ── Watch mode ──────────────────────────────────────────────────────────────
console.log('[Guardian Widget] Watch mode');
console.log('[Guardian Widget] Tip: run `pnpm dev` in figma-plugin/ in parallel to watch plugin changes.');

// 1. Compile the plugin once at startup (ensures dist/code.js exists and is up to date).
//    The widget does NOT spawn tsc --watch: if figma-plugin/pnpm dev runs in parallel,
//    it writes dist/code.js → no conflict between two tsc on the same file.
console.log('[Guardian Widget] Initial plugin build (esbuild)…');
execSync('node build.mjs', { stdio: 'inherit', cwd: pluginDir });

// Cache of the last compiled widget (to re-merge when the plugin changes)
let lastWidgetCode = null;

// 2. esbuild watch: rebuilds the widget on every change in widget-src/
const ctx = await esbuild.context({
  entryPoints: ['widget-src/code.tsx'],
  bundle: true,
  write: false,
  target: 'es6',
  jsxFactory: 'widget.h',
  jsxFragment: 'widget.Fragment',
  logLevel: 'silent',
  plugins: [{
    name: 'merge-on-rebuild',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        lastWidgetCode = result.outputFiles[0].text;
        merge(lastWidgetCode);
        console.log(`[Guardian Widget] ${new Date().toLocaleTimeString()} widget rebuilt → dist/code.js`);
      });
    },
  }],
});
await ctx.watch();

// 3. fs.watch on figma-plugin/dist/: reacts if figma-plugin/pnpm dev runs in parallel
mkdirSync(resolve(pluginDir, 'dist'), { recursive: true });
watch(resolve(pluginDir, 'dist'), { recursive: false }, (_, filename) => {
  if (filename !== 'code.js' || !lastWidgetCode) return;
  try {
    merge(lastWidgetCode);
    console.log(`[Guardian Widget] ${new Date().toLocaleTimeString()} plugin rebuilt → dist/code.js`);
  } catch { /* code.js being written by tsc, will be re-triggered */ }
});

process.on('SIGINT', () => {
  ctx.dispose();
  process.exit(0);
});
