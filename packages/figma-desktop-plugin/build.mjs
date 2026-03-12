/**
 * Build script for Guardian Desktop Plugin.
 * Copies dist/code.js and ui.html from figma-plugin — same code, different manifest
 * (enablePrivatePluginApi: true → figma.fileKey access).
 *
 * Usage:
 *   node build.mjs          — one-shot copy
 *   node build.mjs --watch  — watch figma-plugin for changes and re-copy
 */
import { copyFileSync, mkdirSync, existsSync, watchFile } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(__dirname, '../figma-plugin');
const distDir = resolve(__dirname, 'dist');

const files = [
  { src: resolve(pluginDir, 'dist/code.js'), dest: resolve(distDir, 'code.js') },
  { src: resolve(pluginDir, 'ui.html'), dest: resolve(__dirname, 'ui.html') },
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
