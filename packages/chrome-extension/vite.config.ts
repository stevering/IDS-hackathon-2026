import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
  plugins: [
    webExtension({
      manifest: "./manifest.json",
      watchFilePaths: ["manifest.json"],
    }),
  ],
  build: {
    minify: false,
    sourcemap: true,
    outDir: "dist",
  },
});
