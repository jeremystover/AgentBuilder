import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// CFO web SPA — served at / on cfo.workers.dev. Build output goes to
// apps/cfo/dist (the directory the wrangler [assets] binding serves).
//
// publicDir is overridden to apps/cfo/public so legacy.html (the
// pre-rewrite tax-prep SPA) gets copied verbatim into dist/, where the
// worker can serve it at /legacy.
//
// Dev: `pnpm web:dev` runs Vite on :5173 with HMR; the dev server proxies
// the API surface to `wrangler dev` on :8787.
export default defineConfig({
  root: resolve(__dirname, "src/web"),
  base: "/",
  publicDir: resolve(__dirname, "public"),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/login": "http://localhost:8787",
      "/logout": "http://localhost:8787",
      "/legacy": "http://localhost:8787",
      "/health": "http://localhost:8787",
    },
  },
});
