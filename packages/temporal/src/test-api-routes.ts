/**
 * Test API routes via Next.js server.
 *
 * Signs in via Supabase, extracts the session, builds proper cookies,
 * then tests each orchestration API route.
 *
 * Usage: tsx packages/temporal/src/test-api-routes.ts
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = "https://ookghxkvzdnqicjdslej.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9va2doeGt2emRucWljamRzbGVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzNjA5MzgsImV4cCI6MjA4NzkzNjkzOH0.MpWQMamBCC6_OzM3uFvy15_IhroA0T1cJSq-I2XKkKU";

const TEST_EMAIL = "test1@bkm.me";
const TEST_PASSWORD = "test1test1";

// Supabase SSR cookie chunk format
const COOKIE_NAME = "sb-ookghxkvzdnqicjdslej-auth-token";

async function signIn(): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Sign in failed: ${JSON.stringify(data)}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    userId: data.user.id,
  };
}

function buildCookieHeader(accessToken: string, refreshToken: string): string {
  // @supabase/ssr stores the session as a JSON string, optionally
  // base64url-encoded with "base64-" prefix. It chunks into cookies
  // named sb-<ref>-auth-token.0, .1, etc. (max ~3500 bytes each).
  const sessionJson = JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  // base64url encode with the "base64-" prefix that @supabase/ssr expects
  const base64url = Buffer.from(sessionJson)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const encoded = `base64-${base64url}`;

  // Chunk into ~3500-byte cookies
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += 3500) {
    chunks.push(encoded.slice(i, i + 3500));
  }

  if (chunks.length === 1) {
    return `${COOKIE_NAME}=${chunks[0]}`;
  }

  return chunks.map((chunk, i) => `${COOKIE_NAME}.${i}=${chunk}`).join("; ");
}

async function testRoute(
  name: string,
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
  expectStatus?: number
): Promise<unknown> {
  console.log(`\n--- ${name} ---`);
  console.log(`  ${method} ${path}`);

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }

  const expected = expectStatus ?? 200;
  if (res.status === expected) {
    console.log(`  ${res.status} OK`);
    console.log(`  Response: ${JSON.stringify(json).slice(0, 200)}`);
  } else {
    console.log(`  FAIL: expected ${expected}, got ${res.status}`);
    console.log(`  Response: ${JSON.stringify(json).slice(0, 500)}`);
  }

  return json;
}

async function testSSE(
  name: string,
  path: string,
  cookie: string,
  durationMs = 10_000
): Promise<void> {
  console.log(`\n--- ${name} ---`);
  console.log(`  GET ${path} (SSE, ${durationMs / 1000}s)`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), durationMs);

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });

    if (res.status !== 200) {
      console.log(`  FAIL: ${res.status}`);
      console.log(`  ${await res.text()}`);
      return;
    }

    console.log(`  ${res.status} OK — reading events...`);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let eventCount = 0;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split("\n").filter((l) => l.startsWith("data:"));
        for (const line of lines) {
          eventCount++;
          const data = line.slice(5).trim();
          try {
            const evt = JSON.parse(data);
            console.log(`  [event #${eventCount}] type=${evt.type}`);
          } catch {
            console.log(`  [event #${eventCount}] ${data.slice(0, 100)}`);
          }
        }
      }
    }

    console.log(`  Total events: ${eventCount}`);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.log(`  SSE read stopped after ${durationMs / 1000}s (OK)`);
    } else {
      console.log(`  FAIL: ${(err as Error).message}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  console.log("=== API Route Tests ===");
  console.log(`Base: ${BASE_URL}`);

  // Sign in
  console.log("\nSigning in...");
  const { accessToken, refreshToken, userId } = await signIn();
  console.log(`  User: ${userId.slice(0, 8)}...`);

  const cookie = buildCookieHeader(accessToken, refreshToken);

  // Test 1: Start without auth
  await testRoute("Start without auth", "POST", "/api/orchestration/start", "", {
    task: "test",
    targetAgents: [],
  }, 401);

  // Test 2: Start with missing fields
  await testRoute("Start with missing fields", "POST", "/api/orchestration/start", cookie, {
    task: "",
    targetAgents: [],
  }, 400);

  // Test 3: Start orchestration
  const startResult = (await testRoute("Start orchestration", "POST", "/api/orchestration/start", cookie, {
    task: "Create a button component with primary and secondary variants",
    targetAgents: [
      { shortId: "api-agent-1", workflowId: "", label: "API Agent 1", type: "figma-plugin", fileName: "test.fig" },
      { shortId: "api-agent-2", workflowId: "", label: "API Agent 2", type: "web" },
    ],
    maxDurationMs: 30_000,
  })) as { workflowId?: string; error?: string };

  if (!startResult?.workflowId) {
    console.log("\nCannot continue without workflowId. Exiting.");
    process.exit(1);
  }

  const workflowId = startResult.workflowId;
  console.log(`\nWorkflow ID: ${workflowId}`);

  // Wait for workflow to start
  await new Promise((r) => setTimeout(r, 2000));

  // Test 4: Get status
  await testRoute("Get status", "GET", `/api/orchestration/${workflowId}/status`, cookie);

  // Test 5: Send user input
  await testRoute("Send user input", "POST", `/api/orchestration/${workflowId}/signal`, cookie, {
    signal: "userInput",
    payload: { content: "Focus on primary button first" },
  });

  // Test 6: SSE stream (read for 12s)
  await testSSE("SSE stream", `/api/orchestration/${workflowId}/stream`, cookie, 12_000);

  // Test 7: Stop
  await testRoute("Send stop signal", "POST", `/api/orchestration/${workflowId}/signal`, cookie, {
    signal: "stop",
  });

  // Wait for workflow to process stop
  await new Promise((r) => setTimeout(r, 3000));

  // Test 8: Status after stop
  await testRoute("Status after stop", "GET", `/api/orchestration/${workflowId}/status`, cookie);

  console.log("\n=== Done ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
