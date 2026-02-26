/**
 * Build Guardian Plugin (standalone)
 * Produit code.js depuis code.ts via tsc.
 */

import { execSync } from 'child_process';

console.log('[Guardian Plugin] Compiling (tsc)…');
execSync('tsc -p tsconfig.json', { stdio: 'inherit' });
console.log('[Guardian Plugin] Build complete → code.js');
