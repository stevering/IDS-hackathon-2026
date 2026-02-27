/// <reference types="@figma/widget-typings" />

import {
  sendFigpalInit,
  setupPageChangeListener,
  handleBasicMessage,
  buildNodeUrl,
} from '../../figma-plugin/bridge';

const { widget } = figma;
const { AutoLayout, SVG, Text, Rectangle, useEffect, useSyncedState, useSyncedMap, usePropertyMenu } = widget;

// ── SVG mascot (active — full color) ─────────────────────────────────────────
const SHIELD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-18 -4 136 128" width="80" height="80">
  <path class="guardian-arc" d="M 81 34 A 42 42 0 1 0 81 94"
        fill="none" stroke="#6D28D9" stroke-width="19" stroke-linecap="round"/>
  <path class="guardian-arc" d="M 72 80 L 93 80"
        fill="none" stroke="#6D28D9" stroke-width="15" stroke-linecap="round"/>
  <path d="M 76 37 A 37 37 0 1 0 76 91"
        fill="none" stroke="#A78BFA" stroke-width="5" stroke-linecap="round" opacity="0.45"/>
  <ellipse cx="21" cy="27" rx="10" ry="13" fill="#6D28D9"/>
  <ellipse cx="21" cy="28" rx="6" ry="8" fill="#DDD6FE" opacity="0.75"/>
  <path d="M 31 44 Q 40 40 49 43" fill="none" stroke="#4C1D95" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M 55 43 Q 64 40 73 44" fill="none" stroke="#4C1D95" stroke-width="2.5" stroke-linecap="round"/>
  <ellipse cx="40" cy="52" rx="8" ry="9" fill="white"/>
  <ellipse cx="64" cy="52" rx="8" ry="9" fill="white"/>
  <g class="eye-left">
    <ellipse cx="40" cy="53.5" rx="5.5" ry="6.5" fill="#2E1065"/>
    <circle cx="42" cy="51" r="2.2" fill="white"/>
    <circle cx="38.5" cy="55" r="1" fill="white" opacity="0.6"/>
  </g>
  <g class="eye-right">
    <ellipse cx="64" cy="53.5" rx="5.5" ry="6.5" fill="#2E1065"/>
    <circle cx="66" cy="51" r="2.2" fill="white"/>
    <circle cx="62.5" cy="55" r="1" fill="white" opacity="0.6"/>
  </g>
  <path d="M 32 64 Q 52 78 72 64"
        fill="none" stroke="#4C1D95" stroke-width="3.5" stroke-linecap="round"/>
  <ellipse cx="29" cy="63" rx="8" ry="4.5" fill="#C4B5FD" opacity="0.55"/>
  <ellipse cx="75" cy="63" rx="8" ry="4.5" fill="#C4B5FD" opacity="0.55"/>
  <path class="guardian-star"
        d="M 87 73 L 88.3 77.7 L 93 79 L 88.3 80.3 L 87 85 L 85.7 80.3 L 81 79 L 85.7 77.7 Z"
        fill="white" opacity="0.92"/>
  <ellipse cx="14" cy="67" rx="6" ry="9" fill="#6D28D9" transform="rotate(-25 14 67)"/>
  <ellipse cx="90" cy="97" rx="6" ry="9" fill="#6D28D9" transform="rotate(15 90 97)"/>
</svg>`;

// ── SVG mascot (idle — muted, no guardian active) ─────────────────────────────
const SHIELD_SVG_IDLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-18 -4 136 128" width="80" height="80">
  <path d="M 81 34 A 42 42 0 1 0 81 94"
        fill="none" stroke="#9CA3AF" stroke-width="19" stroke-linecap="round"/>
  <path d="M 72 80 L 93 80"
        fill="none" stroke="#9CA3AF" stroke-width="15" stroke-linecap="round"/>
  <path d="M 76 37 A 37 37 0 1 0 76 91"
        fill="none" stroke="#D1D5DB" stroke-width="5" stroke-linecap="round" opacity="0.45"/>
  <ellipse cx="21" cy="27" rx="10" ry="13" fill="#9CA3AF"/>
  <ellipse cx="21" cy="28" rx="6" ry="8" fill="#F3F4F6" opacity="0.75"/>
  <path d="M 31 44 Q 40 40 49 43" fill="none" stroke="#6B7280" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M 55 43 Q 64 40 73 44" fill="none" stroke="#6B7280" stroke-width="2.5" stroke-linecap="round"/>
  <ellipse cx="40" cy="52" rx="8" ry="9" fill="white"/>
  <ellipse cx="64" cy="52" rx="8" ry="9" fill="white"/>
  <ellipse cx="40" cy="53.5" rx="5.5" ry="6.5" fill="#9CA3AF"/>
  <circle cx="42" cy="51" r="2.2" fill="white"/>
  <ellipse cx="64" cy="53.5" rx="5.5" ry="6.5" fill="#9CA3AF"/>
  <circle cx="66" cy="51" r="2.2" fill="white"/>
  <path d="M 32 64 Q 52 78 72 64"
        fill="none" stroke="#6B7280" stroke-width="3.5" stroke-linecap="round"/>
  <ellipse cx="29" cy="63" rx="8" ry="4.5" fill="#D1D5DB" opacity="0.55"/>
  <ellipse cx="75" cy="63" rx="8" ry="4.5" fill="#D1D5DB" opacity="0.55"/>
  <ellipse cx="14" cy="67" rx="6" ry="9" fill="#9CA3AF" transform="rotate(-25 14 67)"/>
  <ellipse cx="90" cy="97" rx="6" ry="9" fill="#9CA3AF" transform="rotate(15 90 97)"/>
</svg>`;

// ── Constants ────────────────────────────────────────────────────────────────
const SHARED_NS = 'guardian';
const SHARED_KEY = 'pluginStatus';
const SESSION_TTL = 30 * 1000;      // 30s: session expires if no heartbeat received
const HEARTBEAT_MS = 3 * 1000;      // 3s: keep-alive interval while plugin is open

// ── Local state (not synced) ─────────────────────────────────────────────────
// figma.currentUser is forbidden during widget rendering, so we can't compute
// "iAmActive" from useSyncedMap during render. Instead we use a module-level flag
// that lives in the same JS execution context as the onClick Promise — it persists
// across re-renders triggered while the Promise is pending, and resets to false
// once the Promise resolves (plugin closed).
let localPluginOpen = false;

// ── Widget ───────────────────────────────────────────────────────────────────

function GuardianWidget() {
  // Per-user session map: key = figma user id, value = last heartbeat ts.
  // Each user writes only their own entry → closing one session deletes only
  // that user's key and does not affect others (fixes the multi-user overwrite bug).
  const sessions = useSyncedMap<{ ts: number }>('sessions');
  const [lastSeenTs, setLastSeenTs] = useSyncedState('lastSeenTs', 0);

  // ── Derived states ────────────────────────────────────────────────────────
  const isActive = (ts: number) => Date.now() - ts < SESSION_TTL;

  // anyoneActive: at least one user has the plugin open → guardian is on guard
  const anyoneActive = sessions.keys().some(k => {
    const v = sessions.get(k);
    return v != null && isActive(v.ts);
  });

  // Count of currently active guardians
  const activeCount = sessions.keys().filter(k => {
    const v = sessions.get(k);
    return v != null && isActive(v.ts);
  }).length;

  // ── Stale session cleanup ─────────────────────────────────────────────────
  // Runs on every render; removes entries that missed heartbeats (crashed sessions).
  // Stabilizes after one cycle: stale → delete → re-render → no stale → no delete.
  useEffect(() => {
    for (const key of sessions.keys()) {
      const v = sessions.get(key);
      if (v && !isActive(v.ts)) {
        sessions.delete(key);
      }
    }
  });

  usePropertyMenu([], () => {});

  // ── Status display ────────────────────────────────────────────────────────
  // localPluginOpen is reliable within a single window: same JS execution context
  // as the onClick Promise. Unreliable only for same-account multi-window (impossible in prod).
  const iAmActive = localPluginOpen;
  const statusColor = iAmActive ? '#10B981' : anyoneActive ? '#A78BFA' : '#9CA3AF';
  const statusLabel = iAmActive
    ? 'You\'re guarding'
    : anyoneActive
      ? `${activeCount} guardian${activeCount > 1 ? 's' : ''} active`
      : lastSeenTs > 0
        ? 'No guardian active'
        : 'Never activated';

  // ── Open plugin handler ───────────────────────────────────────────────────
  // sessionKey is computed here (event handler context) because figma.currentUser
  // is NOT accessible during widget rendering — only in event handlers.
  const openPlugin = (sessionKey: string) =>
    new Promise<void>((resolve) => {
      figma.showUI(__html__, { width: 400, height: 800, title: 'Guardian' });

      let cleanupDone = false;
      const cleanup = () => {
        if (cleanupDone) return;
        cleanupDone = true;
        clearInterval(heartbeatInterval);
        // Set ts=0 instead of deleting: avoids the race-condition flicker where
        // all clients briefly see anyoneActive=false before other sessions re-sync.
        // The stale cleanup in useEffect will remove this entry on the next render.
        sessions.set(sessionKey, { ts: 0 });
        figma.off('close', cleanup);
        resolve();
      };

      figma.on('close', cleanup);

      // Heartbeat: refresh this session's ts every HEARTBEAT_MS while plugin is open.
      // Faster interval = faster count sync across clients + quicker TTL expiry detection.
      const heartbeatInterval = setInterval(() => {
        const now = Date.now();
        sessions.set(sessionKey, { ts: now });
        setLastSeenTs(now);
      }, HEARTBEAT_MS);

      figma.ui.postMessage({ type: 'GUARDIAN_MODE', mode: 'widget', widgetId: figma.widgetId });

      sendFigpalInit();

      const sendSelection = async (id: string) => {
        const sel = figma.currentPage.selection;
        let imageData: string | null = null;
        if (sel.length > 0) {
          try {
            const bytes = await sel[0].exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
            imageData = `data:image/png;base64,${figma.base64Encode(bytes)}`;
          } catch { /* ignore — export not available for this node type */ }
        }
        figma.ui.postMessage({
          type: 'selection-changed',
          id,
          data: {
            nodes: sel.map((n) => ({ id: n.id, name: n.name, type: n.type })),
            image: imageData,
            nodeUrl: sel[0] ? buildNodeUrl(sel[0].id) : null,
          },
        });
      };

      sendSelection('init');
      figma.on('selectionchange', () => sendSelection('auto-stream'));
      setupPageChangeListener();

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

        if (msg.type === 'HIGHLIGHT_NODE' && msg.nodeId) {
          const node = figma.getNodeById(msg.nodeId);
          if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
            figma.currentPage.selection = [node as SceneNode];
            figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
          }
          return;
        }

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

        if (msg.type === 'get-file-info') {
          const requestId = (msg as { id?: string }).id;
          let currentPage: { id: string; name: string } | null = null;
          let pages: { id: string; name: string }[] = [];
          let currentUser: { id: string | null; name: string } | null = null;
          try { currentPage = { id: figma.currentPage.id, name: figma.currentPage.name }; } catch { /* protected */ }
          try { pages = (figma.root.children as ReadonlyArray<{ id: string; name: string }>).map(p => ({ id: p.id, name: p.name })); } catch { /* protected */ }
          try { currentUser = figma.currentUser ? { id: figma.currentUser.id, name: figma.currentUser.name } : null; } catch { /* protected */ }
          figma.ui.postMessage({
            type: 'response',
            id: requestId,
            data: { name: figma.root.name, fileKey: figma.fileKey, currentPage, pages, currentUser },
          });
          return;
        }

        handleBasicMessage(msg as { type?: string; data?: unknown }, cleanup);
      };
    });

  // ── Click handler ─────────────────────────────────────────────────────────
  const handleOpen = async () => {
    // figma.currentUser is accessible here (event handler context, not render)
    // sessionId is unique per file-open session (even for the same account across
    // multiple desktop windows), which allows testing multi-guardian with two windows.
    const sessionKey = figma.currentUser?.sessionId != null
      ? String(figma.currentUser.sessionId)
      : (figma.currentUser?.id ?? 'anon-widget');
    localPluginOpen = true;   // ← immediately visible to re-renders in this context
    const now = Date.now();
    sessions.set(sessionKey, { ts: now });
    setLastSeenTs(now);
    figma.root.setSharedPluginData(SHARED_NS, SHARED_KEY, JSON.stringify({ connected: true, ts: now }));
    await openPlugin(sessionKey);
    localPluginOpen = false;  // ← Promise resolved = plugin closed
    // sessions.set(sessionKey, { ts: 0 }) was already called inside cleanup().
    // The stale cleanup in useEffect will remove it on the next render (ts=0 → !isActive).
    const stillActive = sessions.keys().some(k => {
      const v = sessions.get(k);
      return v != null && isActive(v.ts);
    });
    figma.root.setSharedPluginData(SHARED_NS, SHARED_KEY, JSON.stringify({ connected: stillActive, ts: Date.now() }));
  };

  // ── Render ────────────────────────────────────────────────────────────────
  // NOTE: `effect` prop (DROP_SHADOW) crashes widgetApi 1.0.0 on AutoLayout. Do NOT add it back.
  // NOTE: `name` prop on root node also crashes. Do NOT add it.
  return (
    <AutoLayout
      direction="vertical"
      horizontalAlignItems="center"
      padding={16}
      spacing={10}
      cornerRadius={16}
      fill={anyoneActive ? '#1E1B4B' : '#F9FAFB'}
    >
      {/* Shield: full color when at least one guardian is active, muted otherwise */}
      <SVG src={anyoneActive ? SHIELD_SVG : SHIELD_SVG_IDLE} width={80} height={80} />

      <Text fontSize={13} fontWeight={700} fill={anyoneActive ? '#EDE9FE' : '#6B7280'} letterSpacing={0.5}>
        Guardian
      </Text>

      {/* Status badge — tapping triggers a re-render to recompute derived state */}
      <AutoLayout
        direction="horizontal"
        spacing={6}
        verticalAlignItems="center"
        padding={{ top: 4, bottom: 4, left: 10, right: 10 }}
        cornerRadius={20}
        fill={anyoneActive ? '#312E81' : '#F3F4F6'}
      >
        <Rectangle width={8} height={8} cornerRadius={4} fill={statusColor} />
        <Text fontSize={10} fill={anyoneActive ? '#C7D2FE' : '#6B7280'}>{statusLabel}</Text>
      </AutoLayout>

      {/* Open button: hidden while plugin is open in this window */}
      {!iAmActive && (
        <AutoLayout
          direction="horizontal"
          spacing={6}
          verticalAlignItems="center"
          padding={{ top: 6, bottom: 6, left: 14, right: 14 }}
          cornerRadius={20}
          fill="#6D28D9"
          onClick={handleOpen}
        >
          <Text fontSize={11} fontWeight={600} fill="#FFFFFF">
            {anyoneActive ? 'Join' : 'Activate Guardian'}
          </Text>
        </AutoLayout>
      )}
    </AutoLayout>
  );
}

// Only register in widget mode (figma.widget exists). In plugin mode widget is undefined.
if (typeof widget?.register === 'function') {
  try {
    widget.register(GuardianWidget);
  } catch (err) {
    console.error('[widget] widget.register failed:', err instanceof Error ? err.message : String(err), err);
  }
}
