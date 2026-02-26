import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  /**
   * Called by the main process when the cursor enters/leaves the overlay bounds.
   * The renderer uses this to update the hover visual state.
   */
  onHoverChange: (callback: (isOver: boolean) => void): void => {
    ipcRenderer.on("hover-change", (_event, isOver: boolean) =>
      callback(isOver)
    );
  },
});
