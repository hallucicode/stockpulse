import { describe, it, expect } from "vitest";
import { regimeFitsSignal } from "@/lib/regime-compatibility";
import type { Analysis, Regime } from "@/types";

type Rec = Analysis["recommendation"];

describe("regimeFitsSignal", () => {
  it("returns ok with no note when regime is undefined (older cache)", () => {
    const result = regimeFitsSignal("STRONG BUY", undefined);
    expect(result).toEqual({ ok: true, note: "" });
  });

  it("returns ok for HOLD regardless of regime", () => {
    const regimes: Regime[] = [
      "trending_up",
      "trending_down",
      "ranging",
      "high_vol_crisis",
    ];
    for (const r of regimes) {
      expect(regimeFitsSignal("HOLD", r)).toEqual({ ok: true, note: "" });
    }
  });

  it("flags every recommendation as headwind in high_vol_crisis", () => {
    const recs: Rec[] = ["STRONG BUY", "BUY", "SELL", "STRONG SELL"];
    for (const rec of recs) {
      const result = regimeFitsSignal(rec, "high_vol_crisis");
      expect(result.ok).toBe(false);
      expect(result.note).toMatch(/high-volatility/i);
    }
  });

  it("flags BUY/STRONG BUY in trending_down as a counter-trend trade", () => {
    for (const rec of ["BUY", "STRONG BUY"] as Rec[]) {
      const result = regimeFitsSignal(rec, "trending_down");
      expect(result.ok).toBe(false);
      expect(result.note).toMatch(/downtrending/i);
    }
  });

  it("flags SELL/STRONG SELL in trending_up as a counter-trend trade", () => {
    for (const rec of ["SELL", "STRONG SELL"] as Rec[]) {
      const result = regimeFitsSignal(rec, "trending_up");
      expect(result.ok).toBe(false);
      expect(result.note).toMatch(/uptrending/i);
    }
  });

  it("passes BUY in trending_up (tailwind)", () => {
    expect(regimeFitsSignal("BUY", "trending_up")).toEqual({
      ok: true,
      note: "",
    });
    expect(regimeFitsSignal("STRONG BUY", "trending_up")).toEqual({
      ok: true,
      note: "",
    });
  });

  it("passes SELL in trending_down (tailwind)", () => {
    expect(regimeFitsSignal("SELL", "trending_down")).toEqual({
      ok: true,
      note: "",
    });
    expect(regimeFitsSignal("STRONG SELL", "trending_down")).toEqual({
      ok: true,
      note: "",
    });
  });

  it("passes every recommendation in ranging regime (neutral)", () => {
    const recs: Rec[] = ["STRONG BUY", "BUY", "SELL", "STRONG SELL"];
    for (const rec of recs) {
      expect(regimeFitsSignal(rec, "ranging")).toEqual({ ok: true, note: "" });
    }
  });
});
