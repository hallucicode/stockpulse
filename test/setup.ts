// Shared test setup. Runs once before every test file in both
// environments (node default + jsdom for tests under `test/components/**`
// and `test/hooks/**` — see `vitest.config.ts`).
//
// DOM-only imports (`@testing-library/jest-dom/vitest`,
// `@testing-library/react`) are dynamic-loaded behind a `typeof window`
// guard so the 39 node-env test files don't pay the ~50ms each to pull
// React Testing Library into a worker that never renders a component.

import { vi, afterEach } from "vitest";

afterEach(() => {
  vi.clearAllMocks();
});

// Always-on stubs (no DOM dependency).

// Global fetch fallback for tests that don't override it explicitly.
// Edge modules like `finnhub.ts` and `news-source.ts` call `fetch`
// directly; tests stub `global.fetch` per-case, but a default keeps
// uncovered paths from throwing `fetch is not defined` on node.
if (!global.fetch) {
  global.fetch = vi.fn();
}

// Mock Next.js navigation + cache. Both API route tests (node env)
// and component tests (jsdom env) may import code that touches these,
// so the mocks are always-on.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

// DOM-only setup. Only loaded under jsdom (component + hook tests).
// Dynamic `import()` keeps the module out of node-env workers'
// dependency graph — the cost of *loading* @testing-library/react is
// what we're trying to avoid for the pure tests, not just the cost of
// the cleanup() call.
if (typeof window !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => {
    cleanup();
  });
}
