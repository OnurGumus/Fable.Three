import { defineConfig } from "vite";

// Run from the repo root: `npm run demo` (Fable watch + Vite) or `npm run demo:build`.
export default defineConfig({
  root: "demo",
  base: "./",
  // three.js alone is ~550 kB minified; the demo adds a few.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 700 },
  server: { watch: { ignored: ["**/*.fs"] } },
});
