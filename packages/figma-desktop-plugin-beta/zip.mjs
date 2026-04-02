/**
 * Creates a distributable zip for beta testers.
 * Output: packages/web/public/plugin/guardian-desktop-plugin-beta.zip
 * Also writes version.json with package version + date + git SHA.
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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

// Read version from package.json
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));
const pkgVersion = pkg.version || '0.0.0';

// Get git SHA (short)
let gitSha = 'unknown';
try {
  gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch { /* not in a git repo */ }

// Build version string: "0.1.0-beta.1+abc1234"
const date = new Date().toISOString().slice(0, 10);
const fullVersion = `${pkgVersion}+${gitSha}`;

// Write version.json
writeFileSync(resolve(outputDir, 'version.json'), JSON.stringify({
  version: fullVersion,
  package: pkgVersion,
  date,
  sha: gitSha,
  filename: zipName,
}, null, 2) + '\n');
console.log(`[beta-plugin] Version: ${fullVersion} (${date})`);

// Create zip with manifest.json + dist/
execSync(`zip -r "${resolve(outputDir, zipName)}" manifest.json dist/`, { cwd: __dirname, stdio: 'inherit' });

console.log(`[beta-plugin] Created ${resolve(outputDir, zipName)}`);
