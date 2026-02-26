/**
 * /api/figma-bridge
 *
 * Pont de communication entre le widget Figma et le plugin Figma.
 * Les deux écrivent/lisent ici via fetch — sans passer par figma.clientStorage.
 *
 * Clé recommandée : fileKey (ID du fichier Figma) pour isoler par document.
 *
 * GET  /api/figma-bridge?key=<key>          → lit l'état courant
 * POST /api/figma-bridge  { key, data }     → écrit un état
 * DELETE /api/figma-bridge?key=<key>        → supprime l'état
 */

import { NextResponse } from 'next/server';

type BridgeEntry = {
  data: unknown;
  updatedAt: number;
};

// globalThis pour survivre aux rechargements de modules Turbopack en dev
const g = globalThis as typeof globalThis & {
  __figmaBridgeStore?: Record<string, BridgeEntry>;
};
if (!g.__figmaBridgeStore) g.__figmaBridgeStore = {};
const store = g.__figmaBridgeStore;

const TTL_MS = 5 * 60 * 1000; // 5 min — purge les entrées stales

function purge() {
  const now = Date.now();
  for (const key of Object.keys(store)) {
    if (now - store[key].updatedAt > TTL_MS) delete store[key];
  }
}

export async function GET(request: Request) {
  purge();
  const key = new URL(request.url).searchParams.get('key') ?? 'default';
  const entry = store[key];
  if (!entry) return NextResponse.json(null);
  return NextResponse.json(entry.data);
}

export async function POST(request: Request) {
  purge();
  const body = (await request.json()) as { key?: string; data: unknown };
  const key = body.key ?? 'default';
  store[key] = { data: body.data, updatedAt: Date.now() };
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const key = new URL(request.url).searchParams.get('key') ?? 'default';
  delete store[key];
  return NextResponse.json({ ok: true });
}
