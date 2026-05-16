// ─── Push notifications via ntfy.sh ───
// Free, no signup, works on any device
// 1. Set NTFY_TOPIC in .env (e.g. "stockpulse-john-alerts")
// 2. Install ntfy app on phone or subscribe at https://ntfy.sh/YOUR_TOPIC

import { log } from "./logger";

const NTFY_TOPIC = process.env.NTFY_TOPIC;

interface NotifyOptions {
  title: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5; // 1=min, 3=default, 5=urgent
  tags?: string[];
  url?: string;
}

export async function sendPushNotification(opts: NotifyOptions) {
  if (!NTFY_TOPIC) {
    log.info("notifications", "skip.no-topic", {
      title: opts.title,
      message: opts.message,
    });
    return;
  }

  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: opts.title,
        Priority: String(opts.priority ?? 3),
        Tags: (opts.tags ?? []).join(","),
        ...(opts.url ? { Click: opts.url } : {}),
      },
      body: opts.message,
    });
  } catch (err) {
    // Non-fatal: a failed push shouldn't break the caller. Logged so we can
    // diagnose ntfy.sh outages or topic mis-config.
    log.warn("notifications", "send.failure", { error: err, title: opts.title });
  }
}

// ─── Stock-specific notifications ───

export function notifyBuySignal(symbol: string, score: number, price: number) {
  return sendPushNotification({
    title: `🟢 BUY Signal: ${symbol}`,
    message: `Score: ${score}/100 | Price: $${price.toFixed(2)} — technical indicators suggest buying opportunity`,
    priority: score >= 40 ? 5 : 3,
    tags: ["chart_with_upwards_trend", "money_with_wings"],
  });
}

export function notifySellSignal(
  symbol: string,
  reason: string,
  plPct: number
) {
  return sendPushNotification({
    title: `🔴 SELL Signal: ${symbol}`,
    message: `${reason} | P&L: ${plPct >= 0 ? "+" : ""}${plPct.toFixed(1)}%`,
    priority: 4,
    tags: ["warning", "chart_with_downwards_trend"],
  });
}

export function notifyStopLoss(symbol: string, plPct: number) {
  return sendPushNotification({
    title: `🚨 STOP LOSS: ${symbol}`,
    message: `Position down ${Math.abs(plPct).toFixed(1)}% — consider exiting immediately`,
    priority: 5,
    tags: ["rotating_light", "skull"],
  });
}
