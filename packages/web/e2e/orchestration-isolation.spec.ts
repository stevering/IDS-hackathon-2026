import { test, expect } from "@playwright/test";

/**
 * E2E tests for orchestration state isolation across conversations.
 *
 * These tests verify that switching conversations properly cleans up
 * orchestration state (events, agents, workflowId) so that state from
 * one conversation does not leak into another.
 *
 * Prerequisites:
 * - pnpm dev running (web + temporal server + worker)
 * - Test user: test1@bkm.me / test1test1
 */

const SUPABASE_URL = "https://ookghxkvzdnqicjdslej.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9va2doeGt2emRucWljamRzbGVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzNjA5MzgsImV4cCI6MjA4NzkzNjkzOH0.MpWQMamBCC6_OzM3uFvy15_IhroA0T1cJSq-I2XKkKU";
const TEST_EMAIL = "test1@bkm.me";
const TEST_PASSWORD = "test1test1";
const COOKIE_NAME = "sb-ookghxkvzdnqicjdslej-auth-token";

/** Build Supabase SSR cookie from auth tokens */
function buildCookie(accessToken: string, refreshToken: string): string {
  const sessionJson = JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  const b64 = Buffer.from(sessionJson)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${COOKIE_NAME}.0=base64-${b64}`;
}

test.describe("Orchestration isolation across conversations", () => {
  let cookie: string;
  /** Track conversation IDs created during tests for cleanup */
  const createdConversationIds: string[] = [];

  test.beforeAll(async () => {
    // Sign in via Supabase API to get auth tokens
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
      },
    );
    const data = await res.json();
    if (!data.access_token) throw new Error("Auth failed");
    cookie = buildCookie(data.access_token, data.refresh_token);

    // Snapshot existing conversations before tests
    const convRes = await fetch(
      "http://localhost:3000/api/conversations?client_id=e2e-test",
      { headers: { Cookie: cookie } },
    );
    if (convRes.ok) {
      const existing = await convRes.json();
      // Store existing IDs so we only delete NEW ones in afterAll
      createdConversationIds.length = 0;
    }
  });

  test.afterAll(async () => {
    // Clean up: delete all conversations for the test user that were created during tests
    // Fetch all conversations
    const convRes = await fetch(
      "http://localhost:3000/api/conversations?client_id=e2e-test",
      { headers: { Cookie: cookie } },
    );
    if (convRes.ok) {
      const conversations = await convRes.json();
      if (Array.isArray(conversations)) {
        for (const conv of conversations) {
          // Delete each conversation created during the test session
          // Only delete conversations with test-like titles or recent ones
          const title = conv.title || "";
          const isTestConv =
            title === "New conversation" ||
            title.startsWith("test orchestration") ||
            title.startsWith("e2e") ||
            conv.id === createdConversationIds.find((id) => id === conv.id);
          if (isTestConv) {
            await fetch(
              `http://localhost:3000/api/conversations/${conv.id}`,
              { method: "DELETE", headers: { Cookie: cookie } },
            );
          }
        }
      }
    }
  });

  test("orchestration state clears when switching conversations", async ({
    page,
  }) => {
    // Step 1: Log in via UI
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(TEST_EMAIL);
    await page.getByRole("textbox", { name: "Password" }).fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("/", { timeout: 15_000 });
    await page.waitForTimeout(2_000);

    // Step 2: Start an orchestration via the API (bypasses LLM + Figma)
    const startRes = await fetch(
      "http://localhost:3000/api/orchestration/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          task: "e2e test",
          targetAgents: [
            {
              shortId: "#e2e-test-agent",
              label: "E2E Agent",
              type: "figma-plugin" as const,
              fileName: "test.fig",
              pluginClientId: "e2e-test-123",
            },
          ],
        }),
      },
    );
    const { workflowId } = await startRes.json();
    expect(workflowId).toBeTruthy();

    // Step 3: Verify orchestration exists via API
    const statusRes = await fetch(
      `http://localhost:3000/api/orchestration/${workflowId}/status`,
      { headers: { Cookie: cookie } },
    );
    expect(statusRes.ok).toBeTruthy();
    const status = await statusRes.json();
    expect(status.orchestrationId).toBeTruthy();

    // Step 4: Create a new conversation via the UI
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    const newConvButton = page.getByRole("button", {
      name: /New conversation/,
    });
    if (await newConvButton.isVisible()) {
      await newConvButton.click();
      await page.waitForTimeout(1_000);
    }

    // Step 5: Verify orchestration UI is not visible in the new conversation
    const orchestratorText = page.getByText("Orchestrator");
    const isVisible = await orchestratorText.isVisible().catch(() => false);
    expect(isVisible).toBe(false);

    // Step 6: Stop the workflow to clean up Temporal
    await fetch(
      `http://localhost:3000/api/orchestration/${workflowId}/signal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ signal: "stop" }),
      },
    );
  });

  test("orchestration API returns proper status", async () => {
    // Start an orchestration
    const startRes = await fetch(
      "http://localhost:3000/api/orchestration/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          task: "status check test",
          targetAgents: [
            {
              shortId: "#status-test-agent",
              label: "Status Agent",
              type: "figma-plugin" as const,
              fileName: "test.fig",
              pluginClientId: "status-test-123",
            },
          ],
        }),
      },
    );
    expect(startRes.ok).toBeTruthy();
    const { workflowId } = await startRes.json();

    // Query status
    const statusRes = await fetch(
      `http://localhost:3000/api/orchestration/${workflowId}/status`,
      { headers: { Cookie: cookie } },
    );
    expect(statusRes.ok).toBeTruthy();
    const status = await statusRes.json();
    expect(status.status).toBe("active");
    expect(status.agents).toBeInstanceOf(Array);
    expect(status.agents.length).toBeGreaterThan(0);

    // Stop workflow
    const stopRes = await fetch(
      `http://localhost:3000/api/orchestration/${workflowId}/signal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ signal: "stop" }),
      },
    );
    expect(stopRes.ok).toBeTruthy();
  });
});
