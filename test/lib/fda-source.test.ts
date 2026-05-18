import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { dbMock, loggerMock } = vi.hoisted(() => ({
  dbMock: {
    watchlistStock: { findMany: vi.fn() },
    fdaEvent: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
  },
  loggerMock: {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/logger", () => loggerMock);

import {
  getRecentApprovalsForSymbol,
  refreshFdaApprovals,
} from "@/lib/fda-source";

const originalFetch = global.fetch;

function mockFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  dbMock.watchlistStock.findMany = vi.fn().mockResolvedValue([]);
  dbMock.fdaEvent.upsert = vi.fn().mockResolvedValue({});
  dbMock.fdaEvent.findMany = vi.fn().mockResolvedValue([]);
  loggerMock.log.info = vi.fn();
  loggerMock.log.warn = vi.fn();
  loggerMock.log.error = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("refreshFdaApprovals — happy path", () => {
  it("matches an approval against the Healthcare watchlist and persists it", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        results: [
          {
            application_number: "BLA125514",
            sponsor_name: "MERCK SHARP & DOHME CORP",
            openfda: { brand_name: ["KEYTRUDA"] },
            submissions: [
              {
                submission_status: "AP",
                submission_status_date: "20260415",
              },
            ],
          },
        ],
      })
    );

    const summary = await refreshFdaApprovals();

    expect(summary).toMatchObject({
      total: 1,
      matched: 1,
      skippedUnmatched: 0,
      errored: 0,
    });
    expect(dbMock.fdaEvent.upsert).toHaveBeenCalledTimes(1);
    const args = dbMock.fdaEvent.upsert.mock.calls[0][0];
    expect(args.create).toMatchObject({
      symbol: "MRK",
      applicationNumber: "BLA125514",
      eventType: "approval",
      applicantName: "MERCK SHARP & DOHME CORP",
      description: "FDA approval: KEYTRUDA (BLA125514)",
    });
    expect(args.create.date).toBeInstanceOf(Date);
  });

  it("filters the watchlist query to Healthcare sector only", async () => {
    global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ results: [] }));
    await refreshFdaApprovals();
    expect(dbMock.watchlistStock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sector: "Healthcare" } })
    );
  });

  it("uses generic name when brand name is missing", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "PFE", name: "Pfizer Inc", sector: "Healthcare" },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        results: [
          {
            application_number: "NDA208447",
            sponsor_name: "PFIZER INC",
            openfda: { generic_name: ["TAFAMIDIS"] },
            submissions: [
              { submission_status: "AP", submission_status_date: "20260501" },
            ],
          },
        ],
      })
    );
    await refreshFdaApprovals();
    const args = dbMock.fdaEvent.upsert.mock.calls[0][0];
    expect(args.create.description).toBe("FDA approval: TAFAMIDIS (NDA208447)");
  });

  it("produces a sane description when neither brand nor generic is available", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "PFE", name: "Pfizer Inc", sector: "Healthcare" },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        results: [
          {
            application_number: "NDA999999",
            sponsor_name: "PFIZER INC",
            submissions: [
              { submission_status: "AP", submission_status_date: "20260501" },
            ],
          },
        ],
      })
    );
    await refreshFdaApprovals();
    const args = dbMock.fdaEvent.upsert.mock.calls[0][0];
    expect(args.create.description).toBe("FDA approval (NDA999999)");
  });

  it("logs match.skipped at info when no watchlist token overlaps (the quiet case)", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        results: [
          {
            application_number: "BLA999",
            sponsor_name: "Some Tiny Bio Inc",
            submissions: [
              { submission_status: "AP", submission_status_date: "20260415" },
            ],
          },
        ],
      })
    );
    const summary = await refreshFdaApprovals();
    expect(summary).toMatchObject({ matched: 0, skippedUnmatched: 1 });
    expect(dbMock.fdaEvent.upsert).not.toHaveBeenCalled();
    expect(loggerMock.log.info).toHaveBeenCalledWith(
      "fda",
      "match.skipped",
      expect.objectContaining({ applicant: "Some Tiny Bio Inc" })
    );
    // Crucially: this case must NOT fire the suspicious warn.
    expect(loggerMock.log.warn).not.toHaveBeenCalledWith(
      "fda",
      "match.skipped.suspicious",
      expect.anything()
    );
  });

  it("escalates to match.skipped.suspicious (warn) when applicant overlaps a watchlist token", async () => {
    // "Merck & Co" is in the watchlist with anchor token "merck".
    // openFDA reports "MERCK GENERICS LLC" — strict matcher refuses
    // (not in KNOWN map; whole-word containment of "merck" works
    // here so this would actually match... let's pick a case the
    // strict matcher refuses but the overlap probe accepts).
    // Use a 3-char overlap: watchlist Vertex "Pharmaceuticals" →
    // applicant contains "pharma" (3 chars overlap on the "vertex"
    // anchor doesn't work; need a real 3-char-only overlap).
    //
    // Simpler: an ambiguous applicant — overlaps TWO watchlist
    // companies' anchors. findWatchlistMatch returns null (ambiguity
    // rule); hasWatchlistTokenOverlap returns the first hit.
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAA", name: "Genomic Biopharma Inc", sector: "Healthcare" },
      { symbol: "BBB", name: "Genomic Therapeutics", sector: "Healthcare" },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        results: [
          {
            application_number: "BLA42",
            sponsor_name: "Genomic Pharmaceuticals",
            submissions: [
              { submission_status: "AP", submission_status_date: "20260415" },
            ],
          },
        ],
      })
    );
    const summary = await refreshFdaApprovals();
    expect(summary).toMatchObject({ matched: 0, skippedUnmatched: 1 });
    expect(dbMock.fdaEvent.upsert).not.toHaveBeenCalled();
    // The actionable warn fired.
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "fda",
      "match.skipped.suspicious",
      expect.objectContaining({
        applicant: "Genomic Pharmaceuticals",
        applicationNumber: "BLA42",
        overlapsWith: expect.stringMatching(/^(AAA|BBB)$/),
        hint: expect.stringContaining("KNOWN_FDA_APPLICANTS"),
      })
    );
    // The hint MUST tell the operator what file to edit.
    const warnCall = loggerMock.log.warn.mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => c[1] === "match.skipped.suspicious"
    );
    expect(warnCall?.[2].hint).toContain("src/lib/fda.ts");
    // And it must NOT also fire the quiet info — exactly one event.
    expect(loggerMock.log.info).not.toHaveBeenCalledWith(
      "fda",
      "match.skipped",
      expect.anything()
    );
  });

  it("returns early with all zeros when the Healthcare watchlist is empty", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([]);
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const summary = await refreshFdaApprovals();
    expect(summary).toMatchObject({
      total: 0,
      matched: 0,
      skippedUnmatched: 0,
      errored: 0,
    });
    // Crucially: didn't even bother fetching openFDA.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("refreshFdaApprovals — robustness", () => {
  it("treats HTTP 404 as 'no results' (not an error)", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    ]);
    global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({}, 404));
    const summary = await refreshFdaApprovals();
    expect(summary.total).toBe(0);
    expect(summary.errored).toBe(0);
  });

  it("logs warn and returns empty on non-404 HTTP error", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    ]);
    global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({}, 503));
    const summary = await refreshFdaApprovals();
    expect(summary.total).toBe(0);
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "fda",
      "fetch.http-error",
      expect.objectContaining({ status: 503 })
    );
  });

  it("logs warn and returns empty on network failure", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    ]);
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const summary = await refreshFdaApprovals();
    expect(summary.total).toBe(0);
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "fda",
      "fetch.network-error",
      expect.any(Object)
    );
  });

  it("logs warn and returns empty when JSON parse fails", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    ]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new Error("bad json")),
    } as unknown as Response);
    const summary = await refreshFdaApprovals();
    expect(summary.total).toBe(0);
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "fda",
      "fetch.parse-error",
      expect.any(Object)
    );
  });

  it("skips rows without an application_number / sponsor_name / submissions", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        results: [
          { application_number: "X" }, // no sponsor_name
          { sponsor_name: "MERCK SHARP & DOHME" }, // no application_number
          {
            application_number: "Y",
            sponsor_name: "MERCK SHARP & DOHME",
            // no submissions array
          },
        ],
      })
    );
    const summary = await refreshFdaApprovals();
    expect(summary.matched).toBe(0);
    expect(dbMock.fdaEvent.upsert).not.toHaveBeenCalled();
  });

  it("skips rows whose submission isn't AP", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        results: [
          {
            application_number: "X",
            sponsor_name: "MERCK SHARP & DOHME",
            submissions: [
              { submission_status: "PR", submission_status_date: "20260415" },
            ],
          },
        ],
      })
    );
    const summary = await refreshFdaApprovals();
    expect(summary.matched).toBe(0);
  });

  it("skips rows whose submission_status_date is malformed", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        results: [
          {
            application_number: "X",
            sponsor_name: "MERCK SHARP & DOHME",
            submissions: [
              { submission_status: "AP", submission_status_date: "bad-date" },
            ],
          },
        ],
      })
    );
    const summary = await refreshFdaApprovals();
    expect(summary.matched).toBe(0);
  });

  it("counts errored when persist fails (continues with other rows)", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
      { symbol: "PFE", name: "Pfizer Inc", sector: "Healthcare" },
    ]);
    dbMock.fdaEvent.upsert
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({});
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        results: [
          {
            application_number: "A",
            sponsor_name: "MERCK SHARP & DOHME",
            submissions: [
              { submission_status: "AP", submission_status_date: "20260415" },
            ],
          },
          {
            application_number: "B",
            sponsor_name: "PFIZER INC",
            submissions: [
              { submission_status: "AP", submission_status_date: "20260420" },
            ],
          },
        ],
      })
    );
    const summary = await refreshFdaApprovals();
    expect(summary).toMatchObject({ matched: 1, errored: 1 });
  });
});

describe("getRecentApprovalsForSymbol", () => {
  it("returns events for the symbol mapped to the public shape, sorted desc by date", async () => {
    const t1 = new Date("2026-04-15T00:00:00Z");
    const t2 = new Date("2026-05-10T00:00:00Z");
    dbMock.fdaEvent.findMany.mockResolvedValue([
      { date: t2, description: "FDA approval: KEYTRUDA (BLA125514)" },
      { date: t1, description: "FDA approval: GARDASIL (BLA125300)" },
    ]);
    const rows = await getRecentApprovalsForSymbol("MRK");
    expect(rows).toEqual([
      {
        date: t2.toISOString(),
        description: "FDA approval: KEYTRUDA (BLA125514)",
      },
      {
        date: t1.toISOString(),
        description: "FDA approval: GARDASIL (BLA125300)",
      },
    ]);

    // Verify Prisma args are sensible.
    const args = dbMock.fdaEvent.findMany.mock.calls[0][0];
    expect(args.where.symbol).toBe("MRK");
    expect(args.where.eventType).toBe("approval");
    expect(args.where.date.gte).toBeInstanceOf(Date);
    expect(args.orderBy).toEqual({ date: "desc" });
  });

  it("returns empty array when no events exist", async () => {
    dbMock.fdaEvent.findMany.mockResolvedValue([]);
    expect(await getRecentApprovalsForSymbol("XYZ")).toEqual([]);
  });
});
