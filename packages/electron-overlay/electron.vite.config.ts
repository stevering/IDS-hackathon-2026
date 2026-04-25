import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "path";

export default defineConfig({
  main: {
    // @guardian/bridge is a workspace package — externalizeDepsPlugin sees it in
    // dependencies and externalizes it. Electron resolves it at runtime via the
    // pnpm symlink node_modules/@guardian/bridge → packages/bridge/dist/index.js
    // This avoids bundling ws and its optional deps (bufferutil, utf-8-validate).
    //
    // @guardian/orchestrations has no dist build (tsc --noEmit) and exports .ts
    // directly, so Node ESM can't load it at runtime. Force it to be bundled by
    // vite instead of externalized.
    plugins: [externalizeDepsPlugin({ exclude: ["@guardian/orchestrations"] })],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
      },
    },
  },
  preload: {
    // The renderer runs with sandbox:true, so the preload script MUST be CommonJS —
    // Electron uses require() to load it inside the sandbox and cannot evaluate ESM
    // (`import` statements throw "Cannot use import statement outside a module").
    // package.json sets "type":"module" globally, so we override with .js + cjs
    // format here only for the preload bundle.
    plugins: [externalizeDepsPlugin({ exclude: ["@guardian/orchestrations"] })],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
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
