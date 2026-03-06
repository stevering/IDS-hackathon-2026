import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createMcpSupabaseClient } from "../lib/supabase.js"

const CHANNEL_BASE = "guardian:execute"

type ExecResult = { success: boolean; result?: unknown; error?: string }

/**
 * Execute code via Supabase Realtime broadcast channel.
 *
 * Flow: MCP broadcasts execute_request on "guardian:execute:{userId}" channel,
 * the webapp (subscribed to the same channel) receives it, executes via
 * postMessage to the Figma plugin, and broadcasts the result back.
 */
async function executeViaSupabase(
  code: string,
  requestId: string,
  timeoutMs: number,
  userId?: string,
  targetClientId?: string
): Promise<ExecResult> {
  const channelName = userId ? `${CHANNEL_BASE}:${userId}` : CHANNEL_BASE
  const supabase = createMcpSupabaseClient()
  const channel = supabase.channel(channelName)

  return new Promise<ExecResult>((resolve) => {
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      channel.unsubscribe()
      resolve({
        success: false,
        error: `Timed out after ${timeoutMs}ms waiting for Supabase Realtime result. Make sure the Figma plugin is open with the Guardian webapp loaded.`,
      })
    }, timeoutMs)

    channel
      .on("broadcast", { event: "execute_result" }, (payload) => {
        const data = payload.payload as {
          requestId: string
          success: boolean
          result?: unknown
          error?: string
        }

        if (data.requestId !== requestId) return
        if (settled) return
        settled = true

        clearTimeout(timer)
        channel.unsubscribe()
        resolve({
          success: data.success,
          result: data.result,
          error: data.error,
        })
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.send({
            type: "broadcast",
            event: "execute_request",
            payload: { requestId, code, timeout: timeoutMs, targetClientId },
          })
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({
            success: false,
            error: `Supabase Realtime channel error: ${status}. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.`,
          })
        }
      })
  })
}

export function registerFigmaExecuteTool(server: McpServer, userId?: string): void {
  server.tool(
    "guardian_figma_execute",
    `Execute arbitrary Figma Plugin API code via the Guardian Figma plugin bridge.

Use this for one-off operations not covered by guardian_run_skill.
Prefer guardian_run_skill for common DS operations (it uses pre-validated code templates).

IMPORTANT: The Guardian Figma plugin must be open in Figma Desktop for this to work.
Communication goes through Supabase Realtime (works locally and remotely).

## How to write code

The code runs as the BODY of an async function — do NOT wrap it in (async () => { ... })().
You can use await directly. Use return to return a value to the caller.
Return values must be JSON-serializable (no Figma node objects — extract their properties).

## Rules
- DO NOT wrap your code in an async IIFE like (async () => { ... })() — just write the body directly.
- Use await for async Figma APIs (figma.loadFontAsync, figma.getNodeByIdAsync, etc.).
- Use return to return a result; if you return nothing the result will be undefined.
- For text nodes, always call await figma.loadFontAsync({ family, style }) before setting .characters.
- Node .strokes accepts Paint objects: { type: 'SOLID', color: { r, g, b } } — no 'width' key. Use .strokeWeight for thickness.
- Node .fills accepts Paint objects: { type: 'SOLID', color: { r, g, b } } — no 'a' (alpha) key.
- Use figma.listAvailableFontsAsync() (async) not figma.listAvailableFonts() (does not exist).
- ONLY Frame, Group, Component, and ComponentSet nodes support .appendChild(). RectangleNode does NOT have appendChild — use a Frame as a button container instead of a Rectangle.
- .paddingAll does NOT exist. Use .paddingTop / .paddingRight / .paddingBottom / .paddingLeft individually.

## Examples

Get current selection:
  return figma.currentPage.selection.map(n => ({ id: n.id, name: n.name, type: n.type }))

Create a frame with a text node:
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  const f = figma.createFrame();
  f.name = 'My Frame';
  f.resize(300, 200);
  f.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  const t = figma.createText();
  t.fontName = { family: 'Inter', style: 'Regular' };
  t.characters = 'Hello';
  t.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
  f.appendChild(t);
  figma.currentPage.appendChild(f);
  return { frameId: f.id }

Create a button (Frame with text label — NOT a Rectangle):
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  const btn = figma.createFrame();
  btn.name = 'Button';
  btn.resize(160, 48);
  btn.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
  btn.cornerRadius = 8;
  btn.layoutMode = 'HORIZONTAL';
  btn.primaryAxisAlignItems = 'CENTER';
  btn.counterAxisAlignItems = 'CENTER';
  const label = figma.createText();
  label.fontName = { family: 'Inter', style: 'Regular' };
  label.characters = 'Click me';
  label.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  btn.appendChild(label);
  figma.currentPage.appendChild(btn);
  return { buttonId: btn.id }`,
    {
      code: z.string().min(1).describe(
        "Figma Plugin API JavaScript code to execute. " +
        "Runs in an async context — you can use await and return. " +
        "Return value must be JSON-serializable."
      ),
      timeout: z.number().optional().describe(
        "Execution timeout in milliseconds (default: 10000)"
      ),
      targetClientId: z.string().optional().describe(
        "Client ID of the target Figma plugin instance. Only this client will execute the code."
      ),
    },
    async ({ code, timeout, targetClientId }) => {
      const timeoutMs = timeout ?? 10_000
      const requestId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      const result = await executeViaSupabase(code, requestId, timeoutMs, userId, targetClientId)

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    }
  )
}
