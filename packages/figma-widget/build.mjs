/**
 * Build combiné Guardian Widget + Plugin
 *
 * Produit dist/code.js qui contient :
 *   - le code widget (widget.register → actif en contexte widget)
 *   - le code plugin (figma.showUI + handlers → actif en contexte plugin)
 *
 * Le code plugin vient de packages/figma-plugin/ (source de vérité).
 * Produit également dist/ui.html (copié depuis figma-plugin/ui.html).
 *
 * Build  : node build.mjs
 * Watch  : node build.mjs --watch
 *   → esbuild surveille widget-src/
 *   → tsc --watch surveille figma-plugin/code.ts
 *   → toute modification (widget ou plugin) reconstruit dist/code.js
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

// ── Fonction de fusion ──────────────────────────────────────────────────────
function merge(widgetCode) {
  const pluginCode = readFileSync(resolve(pluginDir, 'dist/code.js'), 'utf8');
  const merged = `\
// ── Widget (widget.register — no-op en mode plugin) ────────────────────────
${widgetCode}

// ── Plugin (showUI + handlers — uniquement en mode plugin) ──────────────────
if (typeof figma.openPlugin === 'function') {
${pluginCode}
}
`;
  writeFileSync('dist/code.js', merged);
  copyFileSync(resolve(pluginDir, 'ui.html'), 'dist/ui.html');
}

// ── Build unique ────────────────────────────────────────────────────────────
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

// ── Mode watch ──────────────────────────────────────────────────────────────
console.log('[Guardian Widget] Watch mode');
console.log('[Guardian Widget] Tip: run `pnpm dev` in figma-plugin/ in parallel to watch plugin changes.');

// 1. Compiler le plugin une fois au démarrage (s'assure que dist/code.js existe et est à jour).
//    Le widget ne spawne PAS tsc --watch : si figma-plugin/pnpm dev tourne en parallèle,
//    c'est lui qui écrit dist/code.js → pas de conflit entre deux tsc sur le même fichier.
console.log('[Guardian Widget] Initial plugin build (esbuild)…');
execSync('node build.mjs', { stdio: 'inherit', cwd: pluginDir });

// Cache du dernier widget compilé (pour re-fusionner quand le plugin change)
let lastWidgetCode = null;

// 2. esbuild watch : reconstruit le widget à chaque changement dans widget-src/
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

// 3. fs.watch sur figma-plugin/dist/ : réagit si figma-plugin/pnpm dev tourne en parallèle
mkdirSync(resolve(pluginDir, 'dist'), { recursive: true });
watch(resolve(pluginDir, 'dist'), { recursive: false }, (_, filename) => {
  if (filename !== 'code.js' || !lastWidgetCode) return;
  try {
    merge(lastWidgetCode);
    console.log(`[Guardian Widget] ${new Date().toLocaleTimeString()} plugin rebuilt → dist/code.js`);
  } catch { /* code.js en cours d'écriture par tsc, sera re-déclenché */ }
});

process.on('SIGINT', () => {
  ctx.dispose();
  process.exit(0);
});
