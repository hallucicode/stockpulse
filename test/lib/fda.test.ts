import { describe, it, expect } from "vitest";
import {
  evaluateFdaActivity,
  findWatchlistMatch,
  hasWatchlistTokenOverlap,
  KNOWN_FDA_APPLICANTS_LIST,
  normaliseApplicantName,
} from "@/lib/fda";
import { FDA_CONFIG } from "@/lib/config";

describe("normaliseApplicantName", () => {
  it("lowercases", () => {
    expect(normaliseApplicantName("MERCK")).toBe("merck");
  });

  it("strips legal suffixes (Inc, Corp, LLC, Ltd, AG, SA, NV, PLC)", () => {
    expect(normaliseApplicantName("Pfizer Inc.")).toBe("pfizer");
    expect(normaliseApplicantName("Vertex Corporation")).toBe("vertex");
    expect(normaliseApplicantName("Some Co LLC")).toBe("some");
    expect(normaliseApplicantName("ACME Ltd.")).toBe("acme");
    expect(normaliseApplicantName("Roche AG")).toBe("roche");
    expect(normaliseApplicantName("Sanofi SA")).toBe("sanofi");
    expect(normaliseApplicantName("Some Plc")).toBe("some");
  });

  it("strips pharmaceutical-industry suffixes", () => {
    expect(normaliseApplicantName("Vertex Pharmaceuticals")).toBe("vertex");
    expect(normaliseApplicantName("Vertex Pharmaceutical")).toBe("vertex");
    expect(normaliseApplicantName("Genomic Pharma")).toBe("genomic");
    expect(normaliseApplicantName("Sarepta Therapeutics")).toBe("sarepta");
    expect(normaliseApplicantName("Roche Sciences")).toBe("roche");
    expect(normaliseApplicantName("Pfizer Laboratories")).toBe("pfizer");
  });

  it("collapses commas, ampersands and periods to whitespace", () => {
    expect(normaliseApplicantName("Bristol-Myers Squibb")).toBe(
      "bristol-myers squibb"
    );
    expect(normaliseApplicantName("Merck & Co., Inc.")).toBe("merck");
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(normaliseApplicantName("")).toBe("");
    expect(normaliseApplicantName("   ")).toBe("");
  });

  it("is idempotent", () => {
    const once = normaliseApplicantName("Vertex Pharmaceuticals, Inc.");
    expect(normaliseApplicantName(once)).toBe(once);
  });
});

describe("findWatchlistMatch — Tier 1: KNOWN map", () => {
  const watchlist = [
    { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    { symbol: "PFE", name: "Pfizer Inc", sector: "Healthcare" },
    { symbol: "VRTX", name: "Vertex Pharmaceuticals Inc", sector: "Healthcare" },
  ];

  it("matches the canonical applicant strings in the curated list", () => {
    const r = findWatchlistMatch("MERCK SHARP & DOHME CORP", watchlist);
    expect(r?.symbol).toBe("MRK");
  });

  it("matches when openFDA's applicant is a longer string than the curated entry", () => {
    // "MERCK SHARP & DOHME" is curated; openFDA reports
    // "MERCK SHARP & DOHME LLC" sometimes.
    const r = findWatchlistMatch("MERCK SHARP & DOHME LLC", watchlist);
    expect(r?.symbol).toBe("MRK");
  });

  it("ignores casing + punctuation differences", () => {
    const r = findWatchlistMatch("pfizer, inc.", watchlist);
    expect(r?.symbol).toBe("PFE");
  });

  it("only returns tickers that are actually on the watchlist", () => {
    // ABBV is in KNOWN_FDA_APPLICANTS_LIST but absent from THIS watchlist.
    expect(KNOWN_FDA_APPLICANTS_LIST.ABBV).toBeDefined();
    const r = findWatchlistMatch("AbbVie Inc.", watchlist);
    expect(r).toBeNull();
  });
});

describe("findWatchlistMatch — Tier 2: normalised match", () => {
  // Watchlist names chosen to NOT collide with the KNOWN map so we
  // exercise the fallback path. None of these tickers are in the
  // hand-curated list.
  const watchlist = [
    { symbol: "ACME", name: "Acme Biopharma Inc", sector: "Healthcare" },
    { symbol: "GENO", name: "Genomic Solutions Inc", sector: "Healthcare" },
    { symbol: "TINY", name: "Co Ltd", sector: "Healthcare" }, // no token ≥ 4 chars
  ];

  it("matches when the watchlist name's anchor token appears in the applicant", () => {
    const r = findWatchlistMatch("Acme Therapeutics LLC", watchlist);
    expect(r?.symbol).toBe("ACME");
  });

  it("does not match a short common token (avoids 'co' → every Inc)", () => {
    // TINY's only token is "co" which is stripped — no anchor of
    // sufficient length, so it can never match.
    const r = findWatchlistMatch("Acme Corp", watchlist);
    // Acme matches (length 4 ≥ 4); TINY can't match anything.
    expect(r?.symbol).toBe("ACME");
  });

  it("returns null when no anchor is present", () => {
    // Bart Co — "bart" is 4 chars, would normally match… but it's
    // not in the watchlist at all.
    const r = findWatchlistMatch("Bart Therapeutics", watchlist);
    expect(r).toBeNull();
  });

  it("refuses to guess when the applicant matches two watchlist anchors", () => {
    const ambiguous = [
      { symbol: "AAAA", name: "Genomic Biopharma Inc", sector: "Healthcare" },
      { symbol: "BBBB", name: "Genomic Therapeutics", sector: "Healthcare" },
    ];
    const r = findWatchlistMatch("Genomic Pharmaceuticals", ambiguous);
    expect(r).toBeNull();
  });

  it("respects the minMatchTokenLength config override", () => {
    const wl = [{ symbol: "X", name: "ABC Inc", sector: "Healthcare" }]; // 3-char anchor
    const cfg = { ...FDA_CONFIG, minMatchTokenLength: 3 };
    const r = findWatchlistMatch("ABC Pharmaceuticals", wl, cfg);
    expect(r?.symbol).toBe("X");
    // Default config (min length 4) rejects 3-char "abc".
    expect(findWatchlistMatch("ABC Pharmaceuticals", wl)).toBeNull();
  });

  it("uses whole-word matching (no 'merck' inside 'merckhausen')", () => {
    const wl = [{ symbol: "MRK2", name: "Merck Generic", sector: "Healthcare" }];
    const r = findWatchlistMatch("Merckhausen Pharma", wl);
    expect(r).toBeNull();
  });

  it("handles empty applicant string", () => {
    const r = findWatchlistMatch("", [
      { symbol: "X", name: "Anything Inc", sector: "Healthcare" },
    ]);
    expect(r).toBeNull();
  });

  it("handles empty watchlist", () => {
    const r = findWatchlistMatch("Pfizer Inc", []);
    expect(r).toBeNull();
  });
});

describe("hasWatchlistTokenOverlap", () => {
  const watchlist = [
    { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    { symbol: "VRTX", name: "Vertex Pharmaceuticals Inc", sector: "Healthcare" },
  ];

  it("returns the matched row when the applicant shares a ≥3-char token", () => {
    const r = hasWatchlistTokenOverlap("MERCK GENERICS LLC", watchlist);
    expect(r?.symbol).toBe("MRK");
  });

  it("returns null when there's no shared token (the common case)", () => {
    const r = hasWatchlistTokenOverlap("Some Tiny Bio Inc", watchlist);
    expect(r).toBeNull();
  });

  it("uses a more permissive 3-char threshold than findWatchlistMatch (4)", () => {
    // Watchlist name normalises to a 3-char token "abc".
    const wl = [{ symbol: "ABC", name: "Abc Inc", sector: "Healthcare" }];
    // Strict matcher rejects (anchor < 4 chars).
    expect(findWatchlistMatch("Abc Pharmaceuticals", wl)).toBeNull();
    // Overlap probe finds it.
    expect(hasWatchlistTokenOverlap("Abc Pharmaceuticals", wl)?.symbol).toBe(
      "ABC"
    );
  });

  it("returns null for empty applicant", () => {
    expect(hasWatchlistTokenOverlap("", watchlist)).toBeNull();
  });

  it("returns null for empty watchlist", () => {
    expect(hasWatchlistTokenOverlap("Merck Sharp & Dohme", [])).toBeNull();
  });

  it("returns null when applicant tokens are all under 3 chars", () => {
    // After normalisation strips "co inc" → only "a b" left; both
    // tokens < 3 chars, so no anchor.
    const r = hasWatchlistTokenOverlap("A B Co Inc", watchlist);
    expect(r).toBeNull();
  });

  it("works the suspicious near-miss case findWatchlistMatch refuses", () => {
    // VRTX is NOT in KNOWN_FDA_APPLICANTS_LIST for this test fixture;
    // strict matcher uses Tier 2 token-containment with 4-char anchor
    // "vertex". A misspelling 'verteks' wouldn't match (different
    // token entirely), but a string containing 'pharma' alone would
    // (3-char overlap with 'pharmaceuticals' tokens) — let's verify
    // the helper is permissive enough to catch that.
    const r = hasWatchlistTokenOverlap("vertex BioPharma LLC", watchlist);
    expect(r?.symbol).toBe("VRTX");
  });
});

describe("evaluateFdaActivity", () => {
  const NOW = new Date("2026-05-18T12:00:00Z");

  it("returns an empty/zero result when no events are recorded", () => {
    expect(evaluateFdaActivity([], NOW)).toEqual({
      hasRecentApproval: false,
      lastApprovalAt: null,
      description: "",
    });
  });

  it("flags hasRecentApproval=true when at least one event falls in window", () => {
    const r = evaluateFdaActivity(
      [{ date: "2026-05-10T00:00:00Z", description: "FDA approval: KEYTRUDA" }],
      NOW
    );
    expect(r.hasRecentApproval).toBe(true);
    expect(r.description).toContain("KEYTRUDA");
    expect(r.lastApprovalAt).toBe("2026-05-10T00:00:00.000Z");
  });

  it("flags hasRecentApproval=false when the most recent event is outside window", () => {
    // 30-day window; this approval is 60 days old.
    const r = evaluateFdaActivity(
      [{ date: "2026-03-18T00:00:00Z", description: "Old approval" }],
      NOW
    );
    expect(r.hasRecentApproval).toBe(false);
    // We still surface the last approval date for audit purposes.
    expect(r.lastApprovalAt).toBe("2026-03-18T00:00:00.000Z");
    expect(r.description).toBe("");
  });

  it("picks the most recent event when multiple exist", () => {
    const r = evaluateFdaActivity(
      [
        { date: "2026-04-01T00:00:00Z", description: "First" },
        { date: "2026-05-15T00:00:00Z", description: "Second" },
        { date: "2026-05-10T00:00:00Z", description: "Third" },
      ],
      NOW
    );
    expect(r.lastApprovalAt).toBe("2026-05-15T00:00:00.000Z");
    expect(r.description).toBe("Second");
  });

  it("handles unparseable dates gracefully (null lastApprovalAt)", () => {
    const r = evaluateFdaActivity(
      [{ date: "not-a-date", description: "Broken" }],
      NOW
    );
    expect(r.lastApprovalAt).toBeNull();
    expect(r.hasRecentApproval).toBe(false);
  });

  it("respects a custom approvalWindowDays via config override", () => {
    const cfg = { ...FDA_CONFIG, approvalWindowDays: 1 };
    // 2 days old — outside a 1-day window, inside the default 30-day.
    const event = {
      date: "2026-05-16T12:00:00Z",
      description: "X",
    };
    expect(evaluateFdaActivity([event], NOW, cfg).hasRecentApproval).toBe(false);
    expect(evaluateFdaActivity([event], NOW).hasRecentApproval).toBe(true);
  });
});

describe("KNOWN_FDA_APPLICANTS_LIST sanity", () => {
  it("contains a non-trivial set of big-pharma tickers", () => {
    expect(Object.keys(KNOWN_FDA_APPLICANTS_LIST).length).toBeGreaterThanOrEqual(15);
    expect(KNOWN_FDA_APPLICANTS_LIST.MRK).toBeDefined();
    expect(KNOWN_FDA_APPLICANTS_LIST.PFE).toBeDefined();
    expect(KNOWN_FDA_APPLICANTS_LIST.JNJ).toBeDefined();
  });

  it("entries are non-empty arrays of strings", () => {
    for (const [ticker, names] of Object.entries(KNOWN_FDA_APPLICANTS_LIST)) {
      expect(ticker).toMatch(/^[A-Z]{1,5}$/);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(typeof name).toBe("string");
        expect(name.length).toBeGreaterThan(0);
      }
    }
  });
});
