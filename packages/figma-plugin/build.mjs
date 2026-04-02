/**
 * Build Guardian Plugin (standalone)
 * Uses esbuild to bundle code.ts + bridge.ts → dist/code.js
 */

import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

const GUARDIAN_URL = process.env.GUARDIAN_URL || 'http://localhost:3000';

mkdirSync('dist', { recursive: true });

const isWatch = process.argv.includes('--watch');

const isProd = !isWatch && GUARDIAN_URL !== 'http://localhost:3000';

const buildOptions = {
  entryPoints: ['code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es6',
  platform: 'browser',
  logLevel: 'silent',
  minify: isProd,
};

// Copy ui.html → dist/ui.html with GUARDIAN_URL replacement + optional minification
async function buildUiHtml() {
  let html = readFileSync('ui.html', 'utf8');
  html = html.replace('__GUARDIAN_URL__', GUARDIAN_URL);

  if (isProd) {
    // Minify inline <script> blocks via esbuild transform
    html = await minifyInlineScripts(html);
    // Collapse whitespace in HTML (preserve <pre>/<code> content)
    html = html
      .replace(/<!--[\s\S]*?-->/g, '')         // strip HTML comments
      .replace(/>\s+</g, '><')                  // collapse whitespace between tags
      .replace(/\s{2,}/g, ' ');                  // reduce multiple spaces
  }

  writeFileSync('dist/ui.html', html);
}

async function minifyInlineScripts(html) {
  const scriptRegex = /(<script[^>]*>)([\s\S]*?)(<\/script>)/gi;
  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    parts.push(html.slice(lastIndex, match.index));
    const [, openTag, code, closeTag] = match;
    if (code.trim()) {
      try {
        const result = await esbuild.transform(code, {
          minify: true,
          target: 'es6',
        });
        parts.push(openTag + result.code + closeTag);
      } catch {
        parts.push(match[0]); // keep original on error
      }
    } else {
      parts.push(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  parts.push(html.slice(lastIndex));
  return parts.join('');
}

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  await buildUiHtml();
  console.log(`[Guardian Plugin] Watching for changes… (dist/code.js, GUARDIAN_URL=${GUARDIAN_URL})`);
} else {
  await esbuild.build(buildOptions);
  await buildUiHtml();
  const mode = isProd ? 'PRODUCTION (minified)' : 'development';
  console.log(`[Guardian Plugin] Build complete → dist/code.js + dist/ui.html (${mode}, GUARDIAN_URL=${GUARDIAN_URL})`);
}
