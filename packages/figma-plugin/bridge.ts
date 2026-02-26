/**
 * Shared bridge — used by both the standalone plugin (code.ts)
 * and the widget onClick handler (widget-src/code.tsx).
 *
 * Contains only the logic that is identical in both contexts.
 * Selection handling is intentionally excluded: the plugin exports
 * full node data + image, while the widget sends a lightweight payload.
 */

export function buildNodeUrl(nodeId: string): string | null {
  return figma.fileKey
    ? `https://www.figma.com/design/${figma.fileKey}?node-id=${nodeId.replace(':', '-')}`
    : null;
}

export function sendFigpalInit(): void {
  figma.ui.postMessage({
    type: 'figpal-init',
    data: {
      pluginVersion: '1.0',
      figmaFileKey: figma.fileKey ?? null,
      userName: figma.currentUser ? figma.currentUser.name : null,
    },
  });
}

export function setupPageChangeListener(): void {
  figma.on('currentpagechange', () => {
    figma.ui.postMessage({
      type: 'page-changed',
      data: {
        currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
        pages: (figma.root.children as ReadonlyArray<{ id: string; name: string }>)
          .map(p => ({ id: p.id, name: p.name })),
      },
    });
  });
}

/** Returns true if the message was handled (caller should not process it further). */
export function handleBasicMessage(
  msg: { type?: string; data?: unknown },
  onClose: () => void,
): boolean {
  if (!msg?.type) return false;

  if (msg.type === 'close' || msg.type === 'CLOSE') {
    figma.closePlugin();
    onClose();
    return true;
  }
  if (msg.type === 'resize') {
    const { width, height } = msg.data as { width: number; height: number };
    figma.ui.resize(width, height);
    return true;
  }
  if (msg.type === 'notify') {
    figma.notify((msg.data as { message?: string })?.message ?? '');
    return true;
  }
  return false;
}
