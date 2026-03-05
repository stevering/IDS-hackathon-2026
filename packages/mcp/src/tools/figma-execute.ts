import { z } from "zod"
import { WebSocket } from "ws"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

const DEFAULT_BRIDGE_PORT = 3002
const DEFAULT_WEBAPP_URL = "http://localhost:3000"

type ExecResult = { success: boolean; result?: unknown; error?: string }

/**
 * Connect to the local BridgeServer as an MCP controller, send an EXECUTE_CODE
 * message, wait for the EXECUTE_CODE_RESULT, and return the result.
 *
 * Requires:
 *   - The Guardian Electron overlay to be running (it hosts the BridgeServer).
 *   - At least one Figma plugin/widget client to be connected to the bridge.
 */
function executeViaLocalBridge(
  code: string,
  requestId: string,
  timeoutMs: number,
  bridgePort: number
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${bridgePort}`)

    const cleanup = (result: ExecResult): void => {
      clearTimeout(timer)
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
      resolve(result)
    }

    const timer = setTimeout(() => {
      cleanup({
        success: false,
        error: `Timed out after ${timeoutMs}ms — make sure the Guardian Electron overlay is running and the Figma plugin is open.`,
      })
    }, timeoutMs)

    ws.on("error", (err) => {
      cleanup({
        success: false,
        error: `Cannot connect to Guardian bridge on ws://localhost:${bridgePort} — is the Electron overlay running? (${err.message})`,
      })
    })

    ws.on("open", () => {
      // Register as an MCP controller
      ws.send(JSON.stringify({ type: "REGISTER", clientType: "mcp-controller" }))
    })

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>

        if (msg["type"] === "REGISTERED") {
          // Registered — now send the code execution request
          ws.send(JSON.stringify({ type: "EXECUTE_CODE", id: requestId, code }))
          return
        }

        if (msg["type"] === "EXECUTE_CODE_RESULT" && msg["id"] === requestId) {
          cleanup({
            success: msg["success"] === true,
            result: msg["result"],
            error: typeof msg["error"] === "string" ? msg["error"] : undefined,
          })
        }
      } catch {
        // ignore malformed messages
      }
    })

    ws.on("close", () => {
      // If the socket closes before we got a result, surface an error
      cleanup({
        success: false,
        error: "Bridge connection closed before receiving EXECUTE_CODE_RESULT.",
      })
    })
  })
}

/**
 * Submit code execution via the Guardian webapp HTTP bridge and poll for the result.
 *
 * Flow: MCP --POST--> /api/figma-execute --poll--> webapp iframe --postMessage--> plugin
 */
async function executeViaWebapp(
  code: string,
  requestId: string,
  timeoutMs: number,
  webappUrl: string
): Promise<ExecResult> {
  const base = webappUrl.replace(/\/+$/, "")

  // Submit the execution request
  const submitResp = await fetch(`${base}/api/figma-execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, code, timeout: timeoutMs }),
  })
  if (!submitResp.ok) {
    return { success: false, error: `Webapp returned ${submitResp.status} on submit.` }
  }

  // Poll for the result
  const pollInterval = 300
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval))
    try {
      const resp = await fetch(
        `${base}/api/figma-execute?action=result&requestId=${encodeURIComponent(requestId)}`
      )
      if (!resp.ok) continue
      const data = await resp.json() as ExecResult | null
      if (data) return data
    } catch {
      // Network error — retry until deadline
    }
  }

  return {
    success: false,
    error: `Timed out after ${timeoutMs}ms waiting for webapp bridge result. Make sure the Figma plugin is open with the Guardian webapp loaded.`,
  }
}

export function registerFigmaExecuteTool(server: McpServer): void {
  server.tool(
    "guardian_figma_execute",
    `Execute arbitrary Figma Plugin API code via the Guardian Figma plugin bridge.

Use this for one-off operations not covered by guardian_run_skill.
Prefer guardian_run_skill for common DS operations (it uses pre-validated code templates).

IMPORTANT: The Guardian Figma plugin must be open in Figma Desktop for this to work.

## Transport modes

- "overlay": connect via the Electron overlay BridgeServer (WebSocket, requires overlay running locally)
- "webapp": connect via the Guardian webapp HTTP bridge (works locally and remotely)
- "auto" (default): try overlay first (fast, 3s), fall back to webapp

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
      transport: z.enum(["auto", "overlay", "webapp"]).optional().describe(
        'Transport mode: "overlay" (WebSocket via Electron overlay), "webapp" (HTTP via Guardian webapp), "auto" (try overlay then webapp). Default: "auto".'
      ),
      bridge_port: z.number().optional().describe(
        `Local BridgeServer port (default: ${DEFAULT_BRIDGE_PORT}). Override via GUARDIAN_BRIDGE_PORT env.`
      ),
      webapp_url: z.string().optional().describe(
        `Guardian webapp URL (default: ${DEFAULT_WEBAPP_URL}). Override via GUARDIAN_WEBAPP_URL env.`
      ),
    },
    async ({ code, timeout, transport, bridge_port, webapp_url }) => {
      const timeoutMs = timeout ?? 10_000
      const port = bridge_port
        ?? Number(process.env["GUARDIAN_BRIDGE_PORT"] ?? DEFAULT_BRIDGE_PORT)
      const webUrl = webapp_url
        ?? process.env["GUARDIAN_WEBAPP_URL"]
        ?? DEFAULT_WEBAPP_URL
      const mode = transport ?? "auto"
      const requestId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      let result: ExecResult

      if (mode === "overlay") {
        result = await executeViaLocalBridge(code, requestId, timeoutMs, port)
      } else if (mode === "webapp") {
        result = await executeViaWebapp(code, requestId, timeoutMs, webUrl)
      } else {
        // auto: try overlay first with a short timeout, fall back to webapp
        result = await executeViaLocalBridge(code, requestId, 3_000, port)
        if (!result.success) {
          result = await executeViaWebapp(code, requestId, timeoutMs, webUrl)
        }
      }

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
