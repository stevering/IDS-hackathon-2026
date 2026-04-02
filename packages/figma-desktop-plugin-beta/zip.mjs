/**
 * Creates a distributable zip for beta testers.
 * Output: packages/web/public/plugin/guardian-desktop-plugin-beta.zip
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(__dirname, '../web/public/plugin');
const zipName = 'guardian-desktop-plugin-beta.zip';

// Verify build output exists
if (!existsSync(resolve(__dirname, 'dist/code.js')) || !existsSync(resolve(__dirname, 'dist/ui.html'))) {
  console.error('[beta-plugin] dist/ not found — run build first');
  process.exit(1);
}

if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

// Create zip with manifest.json + dist/
execSync(`zip -r "${resolve(outputDir, zipName)}" manifest.json dist/`, { cwd: __dirname, stdio: 'inherit' });

console.log(`[beta-plugin] Created ${resolve(outputDir, zipName)}`);
