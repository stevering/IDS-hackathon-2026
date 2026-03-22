import { sendFigpalInit, setupPageChangeListener, handleBasicMessage, buildNodeUrl } from './bridge';

figma.showUI(__html__, { width: 400, height: 800, title: "Guardian" });

// Signal the widget badge via sharedPluginData (readable by any plugin regardless of ID).
// Using setSharedPluginData (synchronous) ensures the close write completes before plugin exit.
const _pluginOpenTs = Date.now();
figma.root.setSharedPluginData('guardian', 'pluginStatus', JSON.stringify({ connected: true, ts: _pluginOpenTs }));

// Covers X-button close (no UI message sent). Synchronous → guaranteed to execute before exit.
// Use Date.now() at close time (not _pluginOpenTs) so ts changes → widget detects the update.
figma.on('close', () => {
  figma.root.setSharedPluginData('guardian', 'pluginStatus', JSON.stringify({ connected: false, ts: Date.now() }));
});

// Check if the plugin was triggered from the Guardian widget
figma.clientStorage.getAsync('guardianWidgetCtx').then((raw) => {
  if (raw) {
    try {
      const ctx = JSON.parse(raw as string);
      figma.ui.postMessage({ type: 'FROM_WIDGET', context: ctx });
    } catch (_) { /* corrupted ctx, ignore */ }
    figma.clientStorage.deleteAsync('guardianWidgetCtx');
  }
});

console.log("Command:", figma.command);

if (figma.command === 'guardian-analyze') {
  figma.notify("Guardian launched via guardian-analyze!", { timeout: 3000 });
}

// ─── GLOBALS ─────────────────────────────────────────────────────────

// Stores credentials in memory so they persist while the plugin is open.
const MEMORY: Record<string, string> = {};

// ─── PROXY HANDLE STORE ─────────────────────────────────────────
// Stores non-serializable Figma objects (nodes, arrays) by handle ID.
// ui.html references them via string IDs in subsequent Proxy messages.
const _proxyHandles = new Map<string, unknown>();
let _proxyHandleCounter = 0;

// ─── TYPES ───────────────────────────────────────────────────────────

interface AutoLayoutInfo {
  mode: 'HORIZONTAL' | 'VERTICAL' | 'GRID';
  padding: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  spacing: number;
  align: {
    primary: string;
    counter: string;
  };
  distribute: string;
}

interface ChildInfo {
  id: string;
  name: string;
  type: string;
}

interface SolidFillInfo {
  type: 'SOLID';
  hex: string;
  opacity: number;
}

interface OtherFillInfo {
  type: string;
}

type FillInfo = SolidFillInfo | OtherFillInfo;

interface TypographyInfo {
  fontSize: TextNode['fontSize'];
  fontWeight: TextNode['fontWeight'];
  fontName: TextNode['fontName'];
  letterSpacing: TextNode['letterSpacing'];
  lineHeight: TextNode['lineHeight'];
}

interface MediaItem {
  id: string;
  name: string;
  paintId: string | null;
}

interface LinkItem {
  id: string;
  url: string;
}

interface MediaCollection {
  images: MediaItem[];
  videos: MediaItem[];
  links: LinkItem[];
}

interface SimplifiedNode {
  id: string;
  name: string;
  type: string;
  autoLayout?: AutoLayoutInfo;
  children?: ChildInfo[];
  childCount?: number;
  fillStyleId?: string;
  strokeStyleId?: string;
  textStyleId?: string;
  effectStyleId?: string;
  variableBindings?: Record<string, VariableAlias>;
  componentProperties?: ComponentProperties;
  characters?: string;
  typography?: TypographyInfo;
  cornerRadius?: number;
  cornerSmoothing?: number;
  hasFill?: boolean;
  fills?: FillInfo[];
  bounds?: Rect | null;
  constraints?: Constraints;
  extractedText?: string;
  hasTextContent?: boolean;
  extractedImages?: MediaItem[];
  extractedVideos?: MediaItem[];
  extractedLinks?: LinkItem[];
}

interface PageInfo {
  id: string;
  name: string;
}

interface CurrentUserInfo {
  id: string | null;
  name: string;
}

// ─── Incoming UI Messages ─────────────────────────────────────────────

interface GetSelectionMessage {
  type: 'get-selection';
  id?: string;
}

interface NotifyMessage {
  type: 'notify';
  data: { message?: string };
}

interface GetVariablesMessage {
  type: 'GET_VARIABLES';
  id?: string;
}

interface ExecuteCodeMessage {
  type: 'EXECUTE_CODE';
  id?: string;
  requestId?: string;
  code: string;
  timeout?: number;
}

interface StorageGetMessage {
  type: 'storage-get';
  data: { key: string };
}

interface StorageSetMessage {
  type: 'storage-set';
  data: { key: string; value: unknown };
}

interface GetFileInfoMessage {
  type: 'get-file-info';
  id?: string;
}

interface ResizeMessage {
  type: 'resize';
  data: { width: number; height: number };
}

interface CloseMessage {
  type: 'close';
}

interface HighlightNodeMessage {
  type: 'HIGHLIGHT_NODE';
  nodeId: string;
}

interface OpenPluginAndConverseMessage {
  type: 'OPEN_PLUGIN_AND_CONVERSE';
}

type IncomingMessage =
    | GetSelectionMessage
    | NotifyMessage
    | GetVariablesMessage
    | ExecuteCodeMessage
    | StorageGetMessage
    | StorageSetMessage
    | GetFileInfoMessage
    | ResizeMessage
    | CloseMessage
    | HighlightNodeMessage
    | OpenPluginAndConverseMessage;

// ─── ENTRY POINT ─────────────────────────────────────────────────────

// Immediately fetch and send variables data + initial selection to UI on startup
(async (): Promise<void> => {
  try {
    console.log('FigPal Bridge: Initializing variables fetch...');
    await sendVariablesData();
  } catch (e) {
    console.error('FigPal Bridge: Failed to fetch initial variables', e);
  }

  try {
    await sendCurrentSelection('init');
  } catch (e) {
    console.error('FigPal Bridge: Failed to send initial selection', e);
  }

  // Handshake: notify the embedded webapp that it's inside the Figma plugin
  sendFigpalInit();
})();

// ─── FUNCTIONS ───────────────────────────────────────────────────────

async function sendCurrentSelection(id?: string): Promise<void> {
  const selection = figma.currentPage.selection;
  const simplified: SimplifiedNode[] = selection.slice(0, 50).map(n => simplifyNode(n));

  let imageData: string | null = null;
  if (selection.length > 0) {
    try {
      const bytes = await selection[0].exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 1 }
      });
      imageData = `data:image/png;base64,${figma.base64Encode(bytes)}`;
    } catch (e) {
      console.warn('FigPal: Failed to export selection image', e);
    }
  }

  const firstNode = selection[0];
  const nodeUrl: string | null = firstNode ? buildNodeUrl(firstNode.id) : null;

  figma.ui.postMessage({
    type: 'selection-changed',
    id: id ?? 'init',
    data: { nodes: simplified, image: imageData, nodeUrl }
  });
}

async function sendVariablesData(id?: string): Promise<void> {
  // Get all local variables and collections
  const variables = await figma.variables.getLocalVariablesAsync();
  const collections = await figma.variables.getLocalVariableCollectionsAsync();

  figma.ui.postMessage({
    type: 'VARIABLES_DATA',
    id: id ?? 'system-init',
    data: {
      success: true,
      timestamp: Date.now(),
      fileKey: figma.fileKey ?? null,
      variables: variables.map(v => ({
        id: v.id,
        name: v.name,
        key: v.key,
        resolvedType: v.resolvedType,
        valuesByMode: v.valuesByMode,
        variableCollectionId: v.variableCollectionId,
        scopes: v.scopes,
        description: v.description,
        hiddenFromPublishing: v.hiddenFromPublishing
      })),
      variableCollections: collections.map(c => ({
        id: c.id,
        name: c.name,
        key: c.key,
        modes: c.modes,
        defaultModeId: c.defaultModeId,
        variableIds: c.variableIds
      }))
    }
  });
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────

figma.ui.onmessage = async (msg: IncomingMessage): Promise<void> => {
  const { type } = msg;

  // The plugin writes its backend status to clientStorage so the widget
  // can update its badge on the next click
  if ((type as string) === 'BACKEND_STATUS') {
    const { status, text } = msg as unknown as { status: string; text: string };
    figma.clientStorage.setAsync('guardianBackendStatus', JSON.stringify({ status, text }));
    return;
  }

  if (type === 'get-selection') {
    const selection = figma.currentPage.selection;
    console.log(`FigPal: Processing selection (${selection.length} nodes requested)`);

    // Slice the root selection too! Only take top 50 nodes.
    const simplified: SimplifiedNode[] = selection.slice(0, 50).map(n => simplifyNode(n));
    console.log(`FigPal: Selection processed (${simplified.length} nodes captured)`);

    let imageData: string | null = null;
    if (selection.length > 0) {
      try {
        // Export the first selected node as a small PNG
        const bytes = await selection[0].exportAsync({
          format: 'PNG',
          constraint: { type: 'SCALE', value: 1 }
        });
        // Convert to base64 for easy transport to extension
        imageData = `data:image/png;base64,${figma.base64Encode(bytes)}`;
      } catch (e) {
        console.warn('FigPal: Failed to export selection image', e);
      }
    }

    const firstNode = selection[0];
    const nodeUrl: string | null = firstNode ? buildNodeUrl(firstNode.id) : null;

    const dataResponse = { nodes: simplified, image: imageData, nodeUrl };

    // If this was an automated stream, use that type. Otherwise use generic 'response'.
    const responseType = msg.id === 'auto-stream' ? 'selection-changed' : 'response';
    figma.ui.postMessage({ type: responseType, id: msg.id, data: dataResponse });
  }

  if (type === 'notify') {
    figma.notify(msg.data.message ?? 'FigPal notification');
  }

  if ((type as string) === 'notify-login-prompt') {
    figma.notify('Sign in to Guardian to analyze your designs 🛡️', {
      timeout: 8000,
      button: {
        text: 'Sign in',
        action: () => {
          figma.ui.postMessage({ type: 'login-prompt-clicked' });
          return false;
        },
      },
    });
  }

  if (type === 'GET_VARIABLES') {
    await sendVariablesData(msg.id);
  }

  // ============================================================================
  // Figma API autocorrect — fix common LLM mistakes before execution
  // ============================================================================

  /**
   * LLMs frequently generate invalid Figma Plugin API code. Rather than
   * burning through all agent steps on the same error, we silently fix
   * the most common mistakes so the code runs on the first try.
   *
   * Each fix is a targeted regex with a narrow scope to avoid unintended
   * side effects. Fixes are additive — they never remove valid code.
   */
  function figmaApiAutocorrect(code: string): string {
    let fixed = code;

    // Fix 1: Remove 'a' (alpha) key from color objects in fills/strokes.
    // Figma .fills/.strokes use { r, g, b } — NOT { r, g, b, a }.
    // Alpha goes in the paint's `opacity` field, not in the color.
    // Matches: , a: 1  or  , a: 0.5  right before a closing brace.
    fixed = fixed.replace(/,\s*a\s*:\s*[\d.]+\s*(?=\s*\})/g, '');

    return fixed;
  }

  // ============================================================================
  // EXECUTE_CODE - Arbitrary code execution
  // ============================================================================
  if (type === 'EXECUTE_CODE') {
    const requestId = msg.id ?? msg.requestId;

    const sendResult = (payload: { success: boolean; result?: unknown; error?: string }): void => {
      try {
        figma.ui.postMessage({ type: 'EXECUTE_CODE_RESULT', id: requestId, ...payload });
      } catch {
        // Fallback: result contained non-serializable values — send stringified version
        figma.ui.postMessage({
          type: 'EXECUTE_CODE_RESULT',
          id: requestId,
          success: false,
          error: `Result could not be serialized: ${String(payload.result ?? payload.error)}`,
        });
      }
    };

    try {
      // ── Guardrail: decode HTML entities that some LLMs emit ──────────
      // kimi-k2.5 and others sometimes produce &amp; / &lt; / &gt; / &quot;
      // inside tool-call code strings, causing syntax errors.
      let sanitized = msg.code
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");

      // ── Guardrail: block figma.closePlugin() ─────────────────────────
      // The LLM must never close the plugin — it kills the bridge.
      // Return an error so the orchestrator/agent knows it was refused.
      if (/figma\s*\.\s*closePlugin\s*\(/.test(sanitized)) {
        figma.notify('⚠️ AI tried to close the plugin — blocked', { timeout: 5000, error: true });
        sendResult({
          success: false,
          error: 'BLOCKED: figma.closePlugin() is forbidden during execution. The plugin must stay open for the orchestration to continue. Remove this call and retry.',
        });
        return;
      }

      // ── Figma API autocorrect ──────────────────────────────────────
      sanitized = figmaApiAutocorrect(sanitized);

      // Wrap the user code in its own try/catch INSIDE the async IIFE.
      // Figma's plugin sandbox sometimes intercepts rejected Promises before they
      // reach our outer catch block, resulting in a silent success with result=undefined.
      // By catching inside the IIFE and returning a sentinel object, errors are always
      // surfaced as return values rather than Promise rejections.
      //
      // Special case: if the code is itself an async IIFE — (async () => { ... })() —
      // our wrapper must use `return await` to capture its result. Without it, the IIFE
      // runs fire-and-forget and the outer function returns undefined.
      const codeBody = sanitized.trim();
      const isAsyncIIFE =
        /^\(?async(\s+function)?\s*\(/.test(codeBody) &&
        /[)]\s*;?\s*$/.test(codeBody);

      const wrappedCode = isAsyncIIFE
        ? `(async function() {
  try {
    return await (${codeBody.replace(/;?\s*$/, '')});
  } catch (__e) {
    const __msg = __e instanceof Error ? __e.message : String(__e);
    const __stk = __e instanceof Error && __e.stack ? __e.stack : '';
    return { __guardian_exec_error: (__stk && __stk.includes(__msg) ? __stk : (__msg + (__stk ? '\\n' + __stk : ''))).trim() };
  }
})()`
        : `(async function() {
  try {
${codeBody}
  } catch (__e) {
    const __msg = __e instanceof Error ? __e.message : String(__e);
    const __stk = __e instanceof Error && __e.stack ? __e.stack : '';
    return { __guardian_exec_error: (__stk && __stk.includes(__msg) ? __stk : (__msg + (__stk ? '\\n' + __stk : ''))).trim() };
  }
})()`;
      const timeoutMs = msg.timeout ?? 15000;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      const timeoutPromise = new Promise<{ __guardian_exec_error: string }>((resolve) => {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          resolve({ __guardian_exec_error: `Execution timed out after ${timeoutMs}ms` });
        }, timeoutMs);
      });

      let codePromise: Promise<unknown>;
      try {
        // eslint-disable-next-line no-eval
        codePromise = eval(wrappedCode) as Promise<unknown>;
      } catch (syntaxError) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        sendResult({
          success: false,
          error: `Syntax error: ${syntaxError instanceof Error ? syntaxError.message : String(syntaxError)}`,
        });
        return;
      }

      // Race code vs timeout. Both promises RESOLVE (never reject) to avoid
      // unhandled promise rejections that corrupt the AI SDK's state machine.
      const result: unknown = await Promise.race([
        codePromise.then(
          (v: unknown) => { if (timeoutTimer && !timedOut) clearTimeout(timeoutTimer); return v; },
          (e: unknown) => { if (timeoutTimer && !timedOut) clearTimeout(timeoutTimer); return { __guardian_exec_error: e instanceof Error ? e.message : String(e) }; },
        ),
        timeoutPromise,
      ]);

      // Check if the inner try/catch captured a runtime error
      if (result !== null && typeof result === 'object' && '__guardian_exec_error' in result) {
        sendResult({
          success: false,
          error: (result as { __guardian_exec_error: string }).__guardian_exec_error,
        });
        return;
      }

      // When an async IIFE was detected, the agent may have written its own try/catch
      // that returns { success: false, error: "..." } on failure. Normalize this to our
      // standard error format so the MCP agent receives a clear success: false signal.
      if (
        isAsyncIIFE &&
        result !== null && typeof result === 'object' &&
        (result as Record<string, unknown>)['success'] === false &&
        typeof (result as Record<string, unknown>)['error'] === 'string'
      ) {
        sendResult({
          success: false,
          error: (result as { error: string }).error,
        });
        return;
      }

      // Test JSON-serializability before sending — Figma nodes and circular refs will throw
      let safeResult: unknown;
      try {
        JSON.stringify(result);
        safeResult = result;
      } catch {
        safeResult = `[non-serializable: ${String(result)}]`;
      }

      sendResult({ success: true, result: safeResult });
    } catch (err) {
      sendResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ============================================================================
  // FIGMA PROXY — Handle-based RPC for structured Figma API access
  // ============================================================================
  if (type === 'PROXY_CALL' || type === 'PROXY_GET' || type === 'PROXY_SET' ||
      type === 'PROXY_SNAPSHOT' || type === 'PROXY_ITERATE' || type === 'PROXY_CALL_EACH' ||
      type === 'PROXY_RELEASE') {
    const proxyMsg = msg as unknown as { type: string; requestId: string; [k: string]: unknown };
    const requestId = proxyMsg.requestId;

    const postProxyResult = (value: unknown): void => {
      try {
        figma.ui.postMessage({ type: 'PROXY_RESULT', requestId, value });
      } catch {
        figma.ui.postMessage({ type: 'PROXY_RESULT', requestId, value: '[non-serializable]' });
      }
    };
    const postProxyError = (error: string): void => {
      figma.ui.postMessage({ type: 'PROXY_RESULT', requestId, error });
    };

    try {
      if (type === 'PROXY_CALL') {
        const { target, method, args } = proxyMsg as unknown as { target: string; method: string; args: unknown[] };
        if (!target) { postProxyError('PROXY_CALL: target is null/undefined'); return; }
        // Resolve target: "figma", "figma.variables", or a handle ID
        let obj: unknown;
        if (target.startsWith('figma')) {
          const parts = target.split('.');
          obj = figma as unknown;
          for (let i = 1; i < parts.length; i++) obj = (obj as Record<string, unknown>)[parts[i]];
        } else {
          obj = _proxyHandles.get(target);
          if (!obj) { postProxyError('Handle not found: ' + target); return; }
        }
        // Resolve handle references in args
        const resolvedArgs = (args || []).map((a: unknown) =>
          typeof a === 'string' && _proxyHandles.has(a as string) ? _proxyHandles.get(a as string) : a
        );
        const raw = await (obj as Record<string, (...a: unknown[]) => unknown>)[method](...resolvedArgs);
        // Serialize result: always store objects as handles (Figma nodes pass
        // JSON.stringify but lose their methods when sent through postMessage)
        if (raw === null || raw === undefined) { postProxyResult(null); return; }
        if (typeof raw === 'symbol') { postProxyResult('__FIGMA_MIXED__'); return; }
        if (typeof raw !== 'object' && typeof raw !== 'function') { postProxyResult(raw); return; }
        const handleId = 'h_' + (++_proxyHandleCounter);
        _proxyHandles.set(handleId, raw);
        postProxyResult(handleId);
      }

      else if (type === 'PROXY_GET') {
        const { handle, prop } = proxyMsg as unknown as { handle: string; prop: string };
        const obj = _proxyHandles.get(handle);
        if (!obj) { postProxyError('Handle not found: ' + handle); return; }
        const val = (obj as Record<string, unknown>)[prop];
        if (val === null || val === undefined) { postProxyResult(val); return; }
        if (typeof val === 'symbol') { postProxyResult('__FIGMA_MIXED__'); return; }
        if (typeof val !== 'object' && typeof val !== 'function') { postProxyResult(val); return; }
        // Store objects as handles (parent nodes, arrays, etc.)
        const handleId = 'h_' + (++_proxyHandleCounter);
        _proxyHandles.set(handleId, val);
        postProxyResult(handleId);
      }

      else if (type === 'PROXY_SET') {
        const { handle, prop, value } = proxyMsg as unknown as { handle: string; prop: string; value: unknown };
        const obj = _proxyHandles.get(handle);
        if (!obj) { postProxyError('Handle not found: ' + handle); return; }
        (obj as Record<string, unknown>)[prop] = value;
        postProxyResult(true);
      }

      else if (type === 'PROXY_SNAPSHOT') {
        const { handle, props } = proxyMsg as unknown as { handle: string; props: string[] };
        const obj = _proxyHandles.get(handle);
        if (!obj) { postProxyError('Handle not found: ' + handle); return; }
        const result: Record<string, unknown> = {};
        for (const p of props) {
          const val = (obj as Record<string, unknown>)[p];
          result[p] = (typeof val === 'symbol') ? '__FIGMA_MIXED__' : val;
        }
        postProxyResult(result);
      }

      else if (type === 'PROXY_ITERATE') {
        const { handle, props } = proxyMsg as unknown as { handle: string; props: string[] };
        const arr = _proxyHandles.get(handle);
        if (!arr) { postProxyError('Handle not found: ' + handle); return; }
        const result = Array.from(arr as Iterable<unknown>).map((item: unknown) => {
          const obj: Record<string, unknown> = {};
          for (const p of props) {
            const val = (item as Record<string, unknown>)[p];
            obj[p] = (typeof val === 'symbol') ? '__FIGMA_MIXED__' : val;
          }
          return obj;
        });
        postProxyResult(result);
      }

      else if (type === 'PROXY_CALL_EACH') {
        const { handle, method, argSets } = proxyMsg as unknown as { handle: string; method: string; argSets: unknown[][] };
        const obj = _proxyHandles.get(handle);
        if (!obj) { postProxyError('Handle not found: ' + handle); return; }
        for (const args of argSets) {
          const resolvedArgs = args.map((a: unknown) =>
            typeof a === 'string' && _proxyHandles.has(a as string) ? _proxyHandles.get(a as string) : a
          );
          await (obj as Record<string, (...a: unknown[]) => unknown>)[method](...resolvedArgs);
        }
        postProxyResult(true);
      }

      else if (type === 'PROXY_RELEASE') {
        const { handles } = proxyMsg as unknown as { handles: string[] };
        for (const h of handles) _proxyHandles.delete(h);
        postProxyResult(true);
      }
    } catch (err) {
      postProxyError(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (type === 'storage-get') {
    const { key } = msg.data;
    figma.clientStorage.getAsync(key).then((value: unknown) => {
      figma.ui.postMessage({ type: 'storage-value', key, value: value ?? null });
    });
    return;
  }

  if (type === 'storage-set') {
    await figma.clientStorage.setAsync(msg.data.key, msg.data.value);
    return;
  }

  if (type === 'get-file-info') {
    let currentPage: PageInfo | null = null;
    let pages: PageInfo[] = [];
    let currentUser: CurrentUserInfo | null = null;

    try { currentPage = { id: figma.currentPage.id, name: figma.currentPage.name }; } catch { /* ignore protected access */ }
    try { pages = figma.root.children.map(p => ({ id: p.id, name: p.name })); } catch { /* ignore protected access */ }
    try {
      currentUser = figma.currentUser
          ? { id: figma.currentUser.id, name: figma.currentUser.name }
          : null;
    } catch { /* ignore protected access */ }

    figma.ui.postMessage({
      type: 'response',
      id: msg.id,
      data: {
        name: figma.root.name,
        fileKey: figma.fileKey,
        currentPage,
        pages,
        currentUser
      }
    });
  }

  if (type === 'HIGHLIGHT_NODE') {
    const nodeId = (msg as HighlightNodeMessage).nodeId;
    figma.getNodeByIdAsync(nodeId).then((node) => {
      if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
        figma.currentPage.selection = [node as SceneNode];
        figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
      }
    });
    return;
  }

  if (type === 'OPEN_PLUGIN_AND_CONVERSE') {
    // Focus the plugin UI and start a new conversation
    // The plugin should already be open, but let's ensure it's visible
    figma.ui.show();

    // Send a message to the UI to reset conversation and trigger analysis
    figma.ui.postMessage({
      type: 'FROM_OVERLAY',
      action: 'START_NEW_CONVERSATION'
    });
    return;
  }

  // Note: close is also handled by figma.on('close') above (covers X-button).
  // The UI close-button message path goes through handleBasicMessage → figma.closePlugin()
  // which triggers the 'close' event, so no extra write needed here.
  handleBasicMessage(msg as { type?: string; data?: unknown }, () => {});
};

// ─── HELPER FUNCTIONS ───────────────────────────────────────────────

// ─── Selection Streaming ─────────────────────────────────────────────

figma.on('selectionchange', () => {
  sendCurrentSelection('auto-stream');
});

setupPageChangeListener();

// ─── CONSOLE CAPTURE ─────────────────────────────────────────────
// Intercept console.* in the QuickJS sandbox and forward to ui.html
// so the WS bridge can relay them to connected MCP servers.
((): void => {
  const levels: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = ['log', 'info', 'warn', 'error', 'debug'];
  const originals: Record<string, (...args: unknown[]) => void> = {};
  for (const level of levels) originals[level] = console[level];

  for (const level of levels) {
    console[level] = (...args: unknown[]): void => {
      originals[level].apply(console, args);
      try {
        const messageParts = args.map(a => typeof a === 'string' ? a : String(a));
        figma.ui.postMessage({
          type: 'CONSOLE_CAPTURE',
          level,
          message: messageParts.join(' '),
          timestamp: Date.now()
        });
      } catch { /* ignore serialization errors */ }
    };
  }
})();

// ─── DOCUMENT CHANGE LISTENER ────────────────────────────────────
// Forward document changes to ui.html for MCP cache invalidation.
// Requires loadAllPagesAsync first when using dynamic-page documentAccess.
figma.loadAllPagesAsync().then(() => {
  figma.on('documentchange', (event) => {
    const changes = event.documentChanges;
    figma.ui.postMessage({
      type: 'DOCUMENT_CHANGE',
      data: {
        hasStyleChanges: changes.some(c => c.type === 'STYLE_CREATE' || c.type === 'STYLE_DELETE' || c.type === 'STYLE_PROPERTY_CHANGE'),
        hasNodeChanges: changes.some(c => c.type === 'PROPERTY_CHANGE' || c.type === 'CREATE' || c.type === 'DELETE'),
        changedNodeIds: changes.filter(c => 'id' in c).map(c => (c as { id: string }).id).slice(0, 50),
        timestamp: Date.now()
      }
    });
  });
}).catch(() => { /* loadAllPages not supported or failed — skip document change tracking */ });

// ─── UTILS ───────────────────────────────────────────────────────────

function simplifyNode(node: SceneNode, depth: number = 0): SimplifiedNode {
  const obj: SimplifiedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  try {
    if ('layoutMode' in node && node.layoutMode !== 'NONE') {
      obj.autoLayout = {
        mode: node.layoutMode,
        padding: {
          top: node.paddingTop,
          right: node.paddingRight,
          bottom: node.paddingBottom,
          left: node.paddingLeft
        },
        spacing: node.itemSpacing,
        align: {
          primary: node.primaryAxisAlignItems,
          counter: node.counterAxisAlignItems
        },
        distribute: node.primaryAxisSizingMode
      };
    }

    if (depth === 0 && 'children' in node) {
      obj.children = node.children.slice(0, 10).map(c => ({
        id: c.id,
        name: c.name,
        type: c.type
      }));
      if (node.children.length > 10) obj.childCount = node.children.length;
    }

    if ('fillStyleId' in node && node.fillStyleId && node.fillStyleId !== figma.mixed) {
      obj.fillStyleId = node.fillStyleId;
    }
    if ('strokeStyleId' in node && node.strokeStyleId) {
      obj.strokeStyleId = node.strokeStyleId as string;
    }
    if ('textStyleId' in node && node.textStyleId && node.textStyleId !== figma.mixed) {
      obj.textStyleId = node.textStyleId;
    }
    if ('effectStyleId' in node && node.effectStyleId) {
      obj.effectStyleId = node.effectStyleId as string;
    }

    if ('variableBindings' in node) {
      obj.variableBindings = (node as SceneNode & { variableBindings: Record<string, VariableAlias> }).variableBindings;
    }

    if (node.type === 'INSTANCE') {
      obj.componentProperties = node.componentProperties;
    }

    if (node.type === 'TEXT') {
      obj.characters = node.characters;
      obj.typography = {
        fontSize: node.fontSize,
        fontWeight: node.fontWeight,
        fontName: node.fontName,
        letterSpacing: node.letterSpacing,
        lineHeight: node.lineHeight
      };
    }

    if ('cornerRadius' in node && node.cornerRadius !== figma.mixed) {
      obj.cornerRadius = node.cornerRadius;
    }
    if ('cornerSmoothing' in node) {
      obj.cornerSmoothing = node.cornerSmoothing;
    }

    if ('fills' in node && Array.isArray(node.fills) && node.fills.length > 0) {
      obj.hasFill = true;
      obj.fills = (node.fills as ReadonlyArray<Paint>).map((paint): FillInfo => {
        if (paint.type === 'SOLID') {
          const { r, g, b } = paint.color;
          const toHex = (c: number): string =>
              Math.round(c * 255).toString(16).padStart(2, '0').toUpperCase();
          return {
            type: 'SOLID',
            hex: `#${toHex(r)}${toHex(g)}${toHex(b)}`,
            opacity: typeof paint.opacity === 'number' ? paint.opacity : 1
          };
        }
        return { type: paint.type };
      });
    }

    if ('absoluteBoundingBox' in node) {
      obj.bounds = node.absoluteBoundingBox;
    }

    if ('constraints' in node) {
      obj.constraints = node.constraints;
    }

    if (depth === 0) {
      const allText = extractText(node);
      if (allText.length > 0) {
        obj.extractedText = allText.substring(0, 10000);
        obj.hasTextContent = true;
      }

      const media = extractMedia(node);
      if (media.images.length > 0) obj.extractedImages = media.images;
      if (media.videos.length > 0) obj.extractedVideos = media.videos;
      if (media.links.length > 0) obj.extractedLinks = media.links;
    }
  } catch {
    // Silently fail for protected properties
  }

  return obj;
}

function extractMedia(node: SceneNode): MediaCollection {
  const media: MediaCollection = { images: [], videos: [], links: [] };

  if ('fills' in node && Array.isArray(node.fills)) {
    for (const paint of node.fills as ReadonlyArray<Paint>) {
      if (paint.type === 'IMAGE') {
        media.images.push({ id: node.id, name: node.name, paintId: paint.imageHash });
      }
      if (paint.type === 'VIDEO') {
        media.videos.push({ id: node.id, name: node.name, paintId: paint.videoHash });
      }
    }
  }

  if (node.type === 'TEXT') {
    const hl = node.hyperlink as HyperlinkTarget | null;
    if (hl?.type === 'URL') {
      media.links.push({ id: node.id, url: hl.value });
    }
  }

  if ('children' in node) {
    for (const child of node.children) {
      const childMedia = extractMedia(child);
      media.images.push(...childMedia.images);
      media.videos.push(...childMedia.videos);
      media.links.push(...childMedia.links);
    }
  }

  return media;
}

function extractText(node: SceneNode): string {
  let text = '';
  if (node.type === 'TEXT') {
    text += node.characters + '\n';
  }
  if ('children' in node) {
    for (const child of node.children) {
      text += extractText(child);
    }
  }
  return text;
}

// Suppress unused variable warning — MEMORY is reserved for future credential storage
void MEMORY;
// FC Bridge compat build marker
// build 1774095805
// instant-connect 1774180608
