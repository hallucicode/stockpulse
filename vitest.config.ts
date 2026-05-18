import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    // Default to `node` so the 39 of 47 test files that don't touch
    // the DOM (pure modules, edge modules, Next API route handlers)
    // skip the ~3-4s of cumulative jsdom-bootstrap each file would
    // otherwise pay. `environmentMatchGlobs` below opts the React
    // component + hook tests back into jsdom.
    //
    // Measured baseline (before this change): test:coverage took
    // ~139s wall clock with `environment: "jsdom"` for all 47 files.
    // Most of the time was env setup, not test work.
    environment: "node",
    environmentMatchGlobs: [
      ["test/components/**", "jsdom"],
      ["test/hooks/**", "jsdom"],
    ],
    setupFiles: ["./test/setup.ts"],
    globals: true,
    // Don't pick up Claude Code worktree copies (each one ships duplicate
    // test files; without this the suite count triples and noise hides
    // real failures).
    exclude: ["node_modules", ".next", "coverage", ".claude/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/types/**",
        "src/app/layout.tsx",
        "src/app/page.tsx",
        "src/instrumentation.ts",
        "src/lib/cron-alerts.ts",
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
