/// <reference types="@figma/widget-typings" />

import {
  sendFigpalInit,
  setupPageChangeListener,
  handleBasicMessage,
  buildNodeUrl,
} from '../../figma-plugin/bridge';

const { widget } = figma;
const { AutoLayout, SVG, Text, Rectangle, useEffect, useSyncedState } = widget;

// ── SVG mascot ───────────────────────────────────────────────────────────────
// viewBox shifted left by 8px so the left tentacle (cx=14) has breathing room.
const SHIELD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 0 136 128" width="128" height="128">
  <path d="M 81 34 A 42 42 0 1 0 81 94"
        fill="none" stroke="#6D28D9" stroke-width="19" stroke-linecap="round"/>
  <path d="M 72 80 L 93 80"
        fill="none" stroke="#6D28D9" stroke-width="15" stroke-linecap="round"/>
  <path d="M 76 37 A 37 37 0 1 0 76 91"
        fill="none" stroke="#A78BFA" stroke-width="5" stroke-linecap="round" opacity="0.45"/>
  <ellipse cx="21" cy="27" rx="10" ry="13" fill="#6D28D9"/>
  <ellipse cx="21" cy="28" rx="6" ry="8" fill="#DDD6FE" opacity="0.75"/>
  <path d="M 31 44 Q 40 40 49 43"
        fill="none" stroke="#4C1D95" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M 55 43 Q 64 40 73 44"
        fill="none" stroke="#4C1D95" stroke-width="2.5" stroke-linecap="round"/>
  <ellipse cx="40" cy="52" rx="8" ry="9" fill="white"/>
  <ellipse cx="64" cy="52" rx="8" ry="9" fill="white"/>
  <ellipse cx="40" cy="53.5" rx="5.5" ry="6.5" fill="#2E1065"/>
  <ellipse cx="64" cy="53.5" rx="5.5" ry="6.5" fill="#2E1065"/>
  <circle cx="42" cy="51" r="2.2" fill="white"/>
  <circle cx="66" cy="51" r="2.2" fill="white"/>
  <circle cx="38.5" cy="55" r="1" fill="white" opacity="0.6"/>
  <circle cx="62.5" cy="55" r="1" fill="white" opacity="0.6"/>
  <path d="M 32 64 Q 52 78 72 64"
        fill="none" stroke="#4C1D95" stroke-width="3.5" stroke-linecap="round"/>
  <ellipse cx="29" cy="63" rx="8" ry="4.5" fill="#C4B5FD" opacity="0.55"/>
  <ellipse cx="75" cy="63" rx="8" ry="4.5" fill="#C4B5FD" opacity="0.55"/>
  <path d="M 87 73 L 88.3 77.7 L 93 79 L 88.3 80.3 L 87 85 L 85.7 80.3 L 81 79 L 85.7 77.7 Z"
        fill="white" opacity="0.92"/>
  <ellipse cx="14" cy="67" rx="6" ry="9" fill="#6D28D9" transform="rotate(-25 14 67)"/>
  <ellipse cx="90" cy="97" rx="6" ry="9" fill="#6D28D9" transform="rotate(15 90 97)"/>
</svg>`;

// ── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'guardianBridgeStatus';

// ── Widget ───────────────────────────────────────────────────────────────────

function GuardianWidget() {
  // Synced state: visible to all Figma users in the file
  const [electronConnected, setElectronConnected] = useSyncedState('electronConnected', false);
  const [lastSeenTs, setLastSeenTs] = useSyncedState('lastSeenTs', 0);

  // Read bridge connection status from clientStorage on every render.
  // clientStorage is written by the UI (via storage-set) when the bridge connects/disconnects.
  useEffect(() => {
    try {
      figma.clientStorage.getAsync(STORAGE_KEY).then((raw) => {
        if (typeof raw !== 'string') return;
        try {
          const data = JSON.parse(raw) as { connected: boolean; ts: number };
          if (data.connected !== electronConnected) setElectronConnected(!!data.connected);
          if (data.ts !== lastSeenTs) setLastSeenTs(data.ts ?? 0);
        } catch (parseErr) { console.error('[widget] clientStorage JSON parse failed:', parseErr instanceof Error ? parseErr.message : String(parseErr)); }
      }).catch((err: unknown) => { console.error('[widget] clientStorage.getAsync rejected:', err instanceof Error ? err.message : String(err)); });
    } catch (err) { console.error('[widget] useEffect clientStorage failed:', err instanceof Error ? err.message : String(err), err); }
  });

  // Status label
  const isRecentlyConnected = electronConnected || (lastSeenTs > 0 && Date.now() - lastSeenTs < 3600_000);
  const statusColor = electronConnected ? '#10B981' : isRecentlyConnected ? '#F59E0B' : '#6B7280';
  const statusLabel = electronConnected
    ? 'Electron actif'
    : lastSeenTs > 0
      ? 'Dernière vue'
      : 'Non connecté';

  // ── Open plugin handler (only triggered by the "Open" button) ─────────────
  const openPlugin = () =>
    new Promise<void>((resolve) => {
      figma.showUI(__html__, { width: 400, height: 800, title: 'Guardian' });

      // Signal the UI that it's running inside a widget (not the standalone plugin).
      figma.ui.postMessage({ type: 'GUARDIAN_MODE', mode: 'widget', widgetId: figma.widgetId });

      // Standard plugin initialisation
      sendFigpalInit();

      const sendSelection = (id: string) => {
        const sel = figma.currentPage.selection;
        figma.ui.postMessage({
          type: 'selection-changed',
          id,
          data: {
            nodes: sel.map((n) => ({ id: n.id, name: n.name, type: n.type })),
            image: null,
            nodeUrl: sel[0] ? buildNodeUrl(sel[0].id) : null,
          },
        });
      };

      sendSelection('init');
      figma.on('selectionchange', () => sendSelection('auto-stream'));
      setupPageChangeListener();

      // ── Message handler for this widget context ───────────────────────────
      figma.ui.onmessage = (msg: {
        type?: string;
        data?: unknown;
        code?: string;
        nodeId?: string;
        id?: string;
        requestId?: string;
        timeout?: number;
        key?: string;
        value?: unknown;
      }) => {
        // EXECUTE_CODE — run arbitrary Figma API JS from the Electron overlay
        if (msg.type === 'EXECUTE_CODE' && msg.code) {
          const requestId = msg.id ?? msg.requestId;
          try {
            const wrapped = `(async function() {\n${msg.code}\n})()`;
            const timeoutMs = msg.timeout ?? 5000;
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
            );
            // eslint-disable-next-line no-eval
            Promise.race([eval(wrapped) as Promise<unknown>, timeoutPromise])
              .then((result) =>
                figma.ui.postMessage({ type: 'EXECUTE_CODE_RESULT', id: requestId, success: true, result })
              )
              .catch((err: unknown) =>
                figma.ui.postMessage({
                  type: 'EXECUTE_CODE_RESULT',
                  id: requestId,
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
                })
              );
          } catch (err: unknown) {
            figma.ui.postMessage({
              type: 'EXECUTE_CODE_RESULT',
              id: requestId,
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        // HIGHLIGHT_NODE — select and scroll to a node
        if (msg.type === 'HIGHLIGHT_NODE' && msg.nodeId) {
          const node = figma.getNodeById(msg.nodeId);
          if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
            figma.currentPage.selection = [node as SceneNode];
            figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
          }
          return;
        }

        // storage-get / storage-set — needed by the BridgeClient to update
        // guardianBridgeStatus so the widget canvas reflects connection state.
        if (msg.type === 'storage-get' && (msg as { data?: { key?: string } }).data?.key) {
          const key = (msg as { data: { key: string } }).data.key;
          figma.clientStorage.getAsync(key).then((value) => {
            figma.ui.postMessage({ type: 'storage-value', key, value: value ?? null });
          });
          return;
        }

        if (msg.type === 'storage-set' && (msg as { data?: { key?: string } }).data?.key) {
          const { key, value } = (msg as { data: { key: string; value: unknown } }).data;
          figma.clientStorage.setAsync(key, value).catch((err: unknown) => { console.error('[widget] storage-set failed:', err instanceof Error ? err.message : String(err)); });
          return;
        }

        // resize / close / notify — handled by shared bridge helper
        handleBasicMessage(msg as { type?: string; data?: unknown }, resolve);
      };
    });

  // ── Render ────────────────────────────────────────────────────────────────
  // NOTE: `effect` prop (DROP_SHADOW) crashes the widget at insertion time —
  // widgetApi 1.0.0 does not support it on AutoLayout. Do NOT add it back.
  return (
    <AutoLayout
      direction="vertical"
      horizontalAlignItems="center"
      padding={16}
      spacing={10}
      cornerRadius={16}
      fill="#F5F3FF"
      onClick={openPlugin}
    >
      <SVG src={SHIELD_SVG} width={80} height={80} />
      <Text fontSize={13} fontWeight={700} fill="#4C1D95" letterSpacing={0.5}>DS AI Guardian</Text>
      <AutoLayout direction="horizontal" spacing={6} verticalAlignItems="center" padding={{ top: 4, bottom: 4, left: 10, right: 10 }} cornerRadius={20} fill="#EDE9FE">
        <Rectangle width={8} height={8} cornerRadius={4} fill={statusColor} />
        <Text fontSize={10} fill="#6D28D9">{statusLabel}</Text>
      </AutoLayout>
    </AutoLayout>
  );
}

// Only register in widget mode (figma.widget exists). In plugin mode widget is undefined.
if (typeof widget?.register === 'function') {
  try {
    widget.register(GuardianWidget);
  } catch (err) {
    // Log the real error — visible in Plugins → Development → Open Console
    console.error('[widget] widget.register failed:', err instanceof Error ? err.message : String(err), err);
  }
}
