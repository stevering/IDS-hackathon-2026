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

  if (type === 'GET_VARIABLES') {
    await sendVariablesData(msg.id);
  }

  // ============================================================================
  // EXECUTE_CODE - Arbitrary code execution (Transplanted from Southleft)
  // ============================================================================
  if (type === 'EXECUTE_CODE') {
    const requestId = msg.id ?? msg.requestId;
    try {
      console.log('FigPal Bridge: Executing code...');
      const wrappedCode = `(async function() {\n${msg.code}\n})()`;
      const timeoutMs = msg.timeout ?? 5000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
            () => reject(new Error(`Execution timed out after ${timeoutMs}ms`)),
            timeoutMs
        );
      });

      let codePromise: Promise<unknown>;
      try {
        // eslint-disable-next-line no-eval
        codePromise = eval(wrappedCode) as Promise<unknown>;
      } catch (syntaxError) {
        const syntaxErrorMsg = syntaxError instanceof Error
            ? syntaxError.message
            : String(syntaxError);
        console.error('FigPal Bridge: Syntax error in code:', syntaxErrorMsg);
        figma.ui.postMessage({
          type: 'EXECUTE_CODE_RESULT',
          id: requestId,
          success: false,
          error: `Syntax error: ${syntaxErrorMsg}`
        });
        return;
      }

      const result: unknown = await Promise.race([codePromise, timeoutPromise]);
      console.log('FigPal Bridge: Code executed successfully');

      figma.ui.postMessage({
        type: 'EXECUTE_CODE_RESULT',
        id: requestId,
        success: true,
        result
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('FigPal Bridge: Execution error:', error.message);
      figma.ui.postMessage({
        type: 'EXECUTE_CODE_RESULT',
        id: requestId,
        success: false,
        error: error.message
      });
    }
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
