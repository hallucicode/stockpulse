import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@prisma/client", () => {
  return {
    PrismaClient: vi.fn().mockImplementation((opts) => ({ __opts: opts })),
  };
});

describe("db", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    // Clear cached prisma global between tests
    delete (globalThis as any).prisma;
  });

  it("creates a PrismaClient with warn/error log in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const mod = await import("@/lib/db");
    expect(mod.db).toBeDefined();
    expect((mod.db as any).__opts.log).toEqual(["warn", "error"]);
    // Cached on globalThis when not production
    expect((globalThis as any).prisma).toBe(mod.db);
  });

  it("creates a PrismaClient with error-only log in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete (globalThis as any).prisma;
    const mod = await import("@/lib/db");
    expect((mod.db as any).__opts.log).toEqual(["error"]);
    // Not cached when production
    expect((globalThis as any).prisma).toBeUndefined();
  });

  it("reuses cached PrismaClient on subsequent imports", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const cached = { __reused: true };
    (globalThis as any).prisma = cached;
    const mod = await import("@/lib/db");
    expect(mod.db).toBe(cached);
  });
});
