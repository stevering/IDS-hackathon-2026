import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "path";

export default defineConfig({
  main: {
    // @guardian/bridge is a workspace package — externalizeDepsPlugin sees it in
    // dependencies and externalizes it. Electron resolves it at runtime via the
    // pnpm symlink node_modules/@guardian/bridge → packages/bridge/dist/index.js
    // This avoids bundling ws and its optional deps (bufferutil, utf-8-validate).
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
