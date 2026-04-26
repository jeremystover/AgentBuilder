import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The Lab SPA — served at /lab/ on research-agent.workers.dev.
// `base` is the public path the bundle's assets are loaded from. Vite
// rewrites every `<script src="...">` and CSS url() against this base
// during build, so the index.html ends up referencing /lab/assets/...
//
// `outDir: ../../dist` writes the build to apps/research-agent/dist (the
// directory the wrangler [assets] binding serves from). The intermediate
// path (../../) is relative to root, which we set to src/lab so Vite can
// resolve src/lab/index.html as the entry.
//
// Dev: `pnpm lab:dev` runs Vite at http://localhost:5173 with HMR; the
// dev server proxies /api and /lab/login to the Worker for auth/data.
export default defineConfig({
  root: resolve(__dirname, "src/lab"),
  base: "/lab/",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api/lab": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/lab/login": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/lab/logout": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
