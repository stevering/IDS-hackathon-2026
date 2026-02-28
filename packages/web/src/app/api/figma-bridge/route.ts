/**
 * /api/figma-bridge
 *
 * Communication bridge between the Figma widget and the Figma plugin.
 * Both write/read here via fetch — without going through figma.clientStorage.
 *
 * Recommended key: fileKey (Figma file ID) to isolate per document.
 *
 * GET  /api/figma-bridge?key=<key>          → reads the current state
 * POST /api/figma-bridge  { key, data }     → writes a state
 * DELETE /api/figma-bridge?key=<key>        → deletes the state
 */

import { NextResponse } from 'next/server';

type BridgeEntry = {
  data: unknown;
  updatedAt: number;
};

// globalThis to survive Turbopack module reloads in dev
const g = globalThis as typeof globalThis & {
  __figmaBridgeStore?: Record<string, BridgeEntry>;
};
if (!g.__figmaBridgeStore) g.__figmaBridgeStore = {};
const store = g.__figmaBridgeStore;

const TTL_MS = 5 * 60 * 1000; // 5 min — purge stale entries

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
