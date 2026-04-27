import { defineConfig } from "vitest/config";

// Vitest config separate from vite.config.ts so the SPA build (which
// pins root to src/web) doesn't constrain test discovery. Tests live
// under src/lib/*.test.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
