/**
 * Build script for Guardian Desktop Plugin Beta.
 * Copies dist/code.js and ui.html from figma-plugin — same code, different manifest.
 * Based on figma-desktop-plugin/build.mjs.
 */
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(__dirname, '../figma-plugin');
const distDir = resolve(__dirname, 'dist');
const GUARDIAN_URL = process.env.GUARDIAN_URL || 'http://localhost:3000';

function build() {
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

  // Copy code.js from figma-plugin build
  const codeSrc = resolve(pluginDir, 'dist/code.js');
  if (!existsSync(codeSrc)) {
    console.error(`[beta-plugin] Source not found: ${codeSrc} — run "pnpm build" in figma-plugin first`);
    process.exit(1);
  }
  copyFileSync(codeSrc, resolve(distDir, 'code.js'));
  console.log(`[beta-plugin] Copied code.js from figma-plugin`);

  // Copy ui.html — prefer pre-built dist/ui.html (already minified + GUARDIAN_URL replaced)
  // Fall back to source ui.html if dist doesn't exist (needs GUARDIAN_URL substitution)
  const uiDist = resolve(pluginDir, 'dist/ui.html');
  const uiSrc = resolve(pluginDir, 'ui.html');
  if (existsSync(uiDist)) {
    copyFileSync(uiDist, resolve(distDir, 'ui.html'));
    console.log(`[beta-plugin] Copied dist/ui.html from figma-plugin (pre-built)`);
  } else if (existsSync(uiSrc)) {
    const html = readFileSync(uiSrc, 'utf8');
    writeFileSync(resolve(distDir, 'ui.html'), html.replace('__GUARDIAN_URL__', GUARDIAN_URL));
    console.log(`[beta-plugin] Built dist/ui.html from source (GUARDIAN_URL=${GUARDIAN_URL})`);
  } else {
    console.error(`[beta-plugin] ui.html not found in figma-plugin`);
    process.exit(1);
  }
}

build();
