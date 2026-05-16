import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("notifications", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it("logs via logger when NTFY_TOPIC is unset", async () => {
    delete process.env.NTFY_TOPIC;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    const logger = await import("@/lib/logger");
    const sink = vi.fn();
    logger.setLoggerSink(sink);

    const mod = await import("@/lib/notifications");
    await mod.sendPushNotification({ title: "T", message: "M" });

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        component: "notifications",
        event: "skip.no-topic",
        meta: expect.objectContaining({ title: "T", message: "M" }),
      })
    );
    expect(fetchMock).not.toHaveBeenCalled();
    logger.resetLoggerSink();
  });

  it("posts to ntfy when topic is set", async () => {
    process.env.NTFY_TOPIC = "my-topic";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;

    const mod = await import("@/lib/notifications");
    await mod.sendPushNotification({
      title: "Hello",
      message: "World",
      priority: 5,
      tags: ["a", "b"],
      url: "https://example.com",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ntfy.sh/my-topic");
    expect(init.method).toBe("POST");
    expect(init.headers.Title).toBe("Hello");
    expect(init.headers.Priority).toBe("5");
    expect(init.headers.Tags).toBe("a,b");
    expect(init.headers.Click).toBe("https://example.com");
    expect(init.body).toBe("World");
  });

  it("uses default priority 3 and empty tags when omitted", async () => {
    process.env.NTFY_TOPIC = "t2";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;

    const mod = await import("@/lib/notifications");
    await mod.sendPushNotification({ title: "X", message: "Y" });
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Priority).toBe("3");
    expect(init.headers.Tags).toBe("");
    expect(init.headers.Click).toBeUndefined();
  });

  it("catches fetch errors and logs them", async () => {
    process.env.NTFY_TOPIC = "boom";
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as any;

    const logger = await import("@/lib/logger");
    const sink = vi.fn();
    logger.setLoggerSink(sink);

    const mod = await import("@/lib/notifications");
    await expect(
      mod.sendPushNotification({ title: "A", message: "B" })
    ).resolves.toBeUndefined();
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        component: "notifications",
        event: "send.failure",
      })
    );
    logger.resetLoggerSink();
  });

  it("notifyBuySignal builds high priority for high score", async () => {
    process.env.NTFY_TOPIC = "x";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
    const mod = await import("@/lib/notifications");
    await mod.notifyBuySignal("AAPL", 50, 100.123);
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Title).toContain("AAPL");
    expect(init.headers.Priority).toBe("5");
  });

  it("notifyBuySignal uses default priority for moderate score", async () => {
    process.env.NTFY_TOPIC = "x";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
    const mod = await import("@/lib/notifications");
    await mod.notifyBuySignal("MSFT", 20, 50);
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Priority).toBe("3");
  });

  it("notifySellSignal formats positive and negative pl", async () => {
    process.env.NTFY_TOPIC = "x";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
    const mod = await import("@/lib/notifications");

    await mod.notifySellSignal("TSLA", "down", 5.2);
    expect(fetchMock.mock.calls[0][1].body).toContain("+5.2%");

    await mod.notifySellSignal("TSLA", "down", -3.1);
    expect(fetchMock.mock.calls[1][1].body).toContain("-3.1%");
  });

  it("notifyStopLoss formats absolute pct", async () => {
    process.env.NTFY_TOPIC = "x";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
    const mod = await import("@/lib/notifications");
    await mod.notifyStopLoss("AAA", -12.4);
    const init = fetchMock.mock.calls[0][1];
    expect(init.body).toContain("12.4%");
    expect(init.headers.Priority).toBe("5");
  });
});
