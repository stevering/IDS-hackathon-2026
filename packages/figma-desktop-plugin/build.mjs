/**
 * Build script for Guardian Desktop Plugin.
 * Copies dist/code.js and ui.html from figma-plugin — same code, different manifest
 * (enablePrivatePluginApi: true → figma.fileKey access).
 *
 * Usage:
 *   node build.mjs          — one-shot copy
 *   node build.mjs --watch  — watch figma-plugin for changes and re-copy
 */
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, watchFile } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(__dirname, '../figma-plugin');
const distDir = resolve(__dirname, 'dist');
const GUARDIAN_URL = process.env.GUARDIAN_URL || 'http://localhost:3000';

const files = [
  { src: resolve(pluginDir, 'dist/code.js'), dest: resolve(distDir, 'code.js') },
];

function copy() {
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
  for (const { src, dest } of files) {
    if (!existsSync(src)) {
      console.warn(`[desktop-plugin] Source not found: ${src} — build figma-plugin first`);
      continue;
    }
    copyFileSync(src, dest);
    console.log(`[desktop-plugin] Copied ${src} → ${dest}`);
  }
  // Build ui.html with GUARDIAN_URL substitution
  const uiSrc = resolve(pluginDir, 'ui.html');
  if (existsSync(uiSrc)) {
    const html = readFileSync(uiSrc, 'utf8');
    writeFileSync(resolve(distDir, 'ui.html'), html.replace('__GUARDIAN_URL__', GUARDIAN_URL));
    console.log(`[desktop-plugin] Built dist/ui.html (GUARDIAN_URL=${GUARDIAN_URL})`);
  }
}

copy();

if (process.argv.includes('--watch')) {
  console.log('[desktop-plugin] Watching figma-plugin for changes…');
  for (const { src } of files) {
    watchFile(src, { interval: 1000 }, () => {
      console.log(`[desktop-plugin] Change detected: ${src}`);
      copy();
    });
  }
}
