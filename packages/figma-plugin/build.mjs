/**
 * Build combiné Guardian Plugin + Widget
 *
 * Produit main.js qui contient :
 *   - le code widget (widget.register → actif en contexte widget)
 *   - le code plugin (figma.showUI → actif en contexte plugin uniquement)
 *
 * La détection de contexte se fait via `typeof figma.openPlugin === 'function'` :
 *   - contexte plugin (manifest combiné, onClick widget) : openPlugin existe → plugin code run
 *   - contexte widget (rendu canvas) : openPlugin absent → seul widget.register tourne
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import * as esbuild from 'esbuild';

// ── 1. Compiler le plugin avec tsc ──────────────────────────────────────────
console.log('[Guardian] Compiling plugin (tsc)…');
execSync('tsc -p tsconfig.json', { stdio: 'inherit' });

// ── 2. Compiler le widget avec esbuild ──────────────────────────────────────
console.log('[Guardian] Compiling widget (esbuild)…');
await esbuild.build({
  entryPoints: ['../figma-widget/widget-src/code.tsx'],
  bundle: true,
  outfile: 'widget.js',
  target: 'es6',
  jsxFactory: 'widget.h',
  jsxFragment: 'widget.Fragment',
  logLevel: 'silent',
});

// ── 3. Fusionner en main.js ──────────────────────────────────────────────────
const widgetCode = readFileSync('widget.js', 'utf8');
const pluginCode = readFileSync('code.js', 'utf8');

// Le code widget tourne toujours (widget.register est no-op en mode plugin).
// Le code plugin est gardé derrière une vérification de contexte :
//   figma.openPlugin est disponible uniquement dans le thread plugin,
//   pas dans le sandbox de rendu du widget.
const main = `\
// ── Widget (widget.register — no-op en mode plugin) ────────────────────────
${widgetCode}

// ── Plugin (showUI + handlers — uniquement en mode plugin) ──────────────────
if (typeof figma.openPlugin === 'function') {
${pluginCode}
}
`;

writeFileSync('main.js', main);
console.log('[Guardian] Build complete → main.js (plugin + widget combinés)');
