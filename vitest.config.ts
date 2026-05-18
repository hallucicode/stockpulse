import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    // Two projects: a `node` env for pure modules / edge modules / API
    // route handlers (the majority — they don't touch the DOM and would
    // otherwise pay a ~3-4s jsdom-bootstrap tax per file), and a `jsdom`
    // env for React components + hooks.
    //
    // Replaces the deprecated `environmentMatchGlobs` (slated for
    // removal in vitest 4) with the supported `projects` API. Both
    // projects inherit the root `test` config via `extends: true` so
    // `setupFiles`, `globals`, `exclude`, and `coverage` apply
    // uniformly — only `environment` and per-project `include` differ.
    //
    // Measured impact of the env split (still applies post-migration):
    // test:coverage went from ~139s wall clock (single jsdom env) to
    // ~50–65s. Most of the time was env setup, not test work.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [
            "test/api/**/*.test.{ts,tsx}",
            "test/lib/**/*.test.{ts,tsx}",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: [
            "test/components/**/*.test.{ts,tsx}",
            "test/hooks/**/*.test.{ts,tsx}",
            "test/app/**/*.test.{ts,tsx}",
          ],
        },
      },
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
