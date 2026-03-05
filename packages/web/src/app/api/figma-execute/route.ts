/**
 * /api/figma-execute
 *
 * HTTP bridge for MCP Guardian -> Webapp -> Figma Plugin code execution.
 *
 * POST  { requestId, code, timeout }           -> submit a code execution request
 * POST  { action:'result', requestId, ... }    -> submit an execution result
 * GET   ?action=pending                        -> claim the oldest pending request
 * GET   ?action=result&requestId=xxx           -> poll for a specific result
 */

import { NextResponse } from "next/server";

type PendingRequest = {
  requestId: string;
  code: string;
  timeout: number;
  createdAt: number;
};

type CompletedResult = {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  completedAt: number;
};

const g = globalThis as typeof globalThis & {
  __figmaExecPending?: Map<string, PendingRequest>;
  __figmaExecResults?: Map<string, CompletedResult>;
};
if (!g.__figmaExecPending) g.__figmaExecPending = new Map();
if (!g.__figmaExecResults) g.__figmaExecResults = new Map();
const pending = g.__figmaExecPending;
const results = g.__figmaExecResults;

const TTL_MS = 30_000;

function purge() {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.createdAt > TTL_MS) pending.delete(k);
  }
  for (const [k, v] of results) {
    if (now - v.completedAt > TTL_MS) results.delete(k);
  }
}

export async function GET(request: Request) {
  purge();
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (action === "pending") {
    // Return and remove the oldest pending request (claim-once)
    const first = pending.values().next();
    if (first.done) return NextResponse.json(null);
    pending.delete(first.value.requestId);
    return NextResponse.json(first.value);
  }

  if (action === "result") {
    const requestId = url.searchParams.get("requestId");
    if (!requestId) return NextResponse.json(null);
    const entry = results.get(requestId);
    if (!entry) return NextResponse.json(null);
    results.delete(requestId);
    return NextResponse.json(entry);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function POST(request: Request) {
  purge();
  const body = (await request.json()) as Record<string, unknown>;

  // Result submission from webapp iframe
  if (body.action === "result") {
    const requestId = body.requestId as string;
    if (!requestId)
      return NextResponse.json({ error: "Missing requestId" }, { status: 400 });
    results.set(requestId, {
      requestId,
      success: body.success as boolean,
      result: body.result,
      error: typeof body.error === "string" ? body.error : undefined,
      completedAt: Date.now(),
    });
    return NextResponse.json({ ok: true });
  }

  // Code execution request from MCP
  const requestId = body.requestId as string;
  const code = body.code as string;
  if (!requestId || !code)
    return NextResponse.json(
      { error: "Missing requestId or code" },
      { status: 400 }
    );
  pending.set(requestId, {
    requestId,
    code,
    timeout: typeof body.timeout === "number" ? body.timeout : 10_000,
    createdAt: Date.now(),
  });
  return NextResponse.json({ ok: true });
}
