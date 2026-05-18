// Phase 12 — FDA drug-approval pure module.
//
// Per CLAUDE.md "Pure core, side effects at edges": this file owns
// the matching logic (which openFDA applicant name belongs to which
// watchlist ticker?) and the catalyst-window evaluation. All I/O
// (openFDA HTTP, DB writes) lives in `./fda-source.ts`.
//
// Two-tier matching strategy:
//   1. `KNOWN_FDA_APPLICANTS` — a hand-curated map of high-traffic
//      tickers to the exact openFDA applicant strings they're known
//      to file under. Day-one quality floor: anything in this map
//      matches with zero false positives.
//   2. Normalised match — for everything else, strip suffixes /
//      punctuation and require a substantial token to anchor a hit.
//      Conservative: false negatives are fine (missed catalyst);
//      false positives are not (phantom catalyst on the wrong stock).

import type { FdaActivity } from "@/types";
import { FDA_CONFIG, type FdaConfig } from "./config";

/**
 * Hand-curated map of ticker → openFDA `sponsor_name` strings.
 *
 * openFDA's `sponsor_name` for a given pharma company can drift
 * between filings (subsidiary names, capitalisation, "Inc." vs
 * "Inc"). This list captures the strings each ticker is *known* to
 * file under, so we don't depend on heuristics for the most-traded
 * names. Add to it cautiously — every entry is essentially a hard-
 * coded promise that "this string really is this ticker."
 *
 * Strings are matched case-insensitively after normalisation, so
 * the casing here is for readability.
 */
const KNOWN_FDA_APPLICANTS: Readonly<Record<string, readonly string[]>> = {
  MRK: ["MERCK SHARP & DOHME", "MERCK SHARP DOHME", "MERCK SHARP & DOHME LLC", "MERCK SHARP & DOHME CORP"],
  PFE: ["PFIZER", "PFIZER INC", "PFIZER LABORATORIES"],
  JNJ: ["JANSSEN", "JANSSEN PHARMACEUTICALS", "JANSSEN BIOTECH", "JANSSEN RESEARCH & DEVELOPMENT"],
  LLY: ["ELI LILLY", "ELI LILLY AND CO", "LILLY"],
  ABBV: ["ABBVIE", "ABBVIE INC"],
  GILD: ["GILEAD SCIENCES", "GILEAD"],
  BMY: ["BRISTOL MYERS SQUIBB", "BRISTOL-MYERS SQUIBB"],
  AMGN: ["AMGEN", "AMGEN INC"],
  REGN: ["REGENERON", "REGENERON PHARMACEUTICALS"],
  VRTX: ["VERTEX PHARMACEUTICALS", "VERTEX"],
  BIIB: ["BIOGEN", "BIOGEN MA INC"],
  MRNA: ["MODERNATX", "MODERNA", "MODERNATX INC"],
  NVAX: ["NOVAVAX"],
  INCY: ["INCYTE", "INCYTE CORPORATION"],
  ALNY: ["ALNYLAM", "ALNYLAM PHARMACEUTICALS"],
  EXEL: ["EXELIXIS"],
  BMRN: ["BIOMARIN", "BIOMARIN PHARMACEUTICAL"],
  IONS: ["IONIS", "IONIS PHARMACEUTICALS"],
  SRPT: ["SAREPTA THERAPEUTICS", "SAREPTA"],
  TAK: ["TAKEDA", "TAKEDA PHARMACEUTICALS"],
} as const;

/**
 * Normalise an applicant or watchlist company name for matching.
 *
 * Strips legal suffixes ("Inc", "Corp", "Co", "Ltd", "LLC", "AG",
 * "SA", "NV", "PLC", "Pharmaceuticals", "Pharma"), punctuation, and
 * collapses whitespace. Lowercase output. The goal is to land on a
 * stable token set: "Vertex Pharmaceuticals, Inc." and "VERTEX
 * PHARMACEUTICALS" should both normalise to "vertex".
 */
export function normaliseApplicantName(name: string): string {
  return name
    .toLowerCase()
    // Drop punctuation that bisects company tokens.
    .replace(/[.,&]/g, " ")
    // Common corporate / legal suffixes — most are noise from our POV.
    // Order matters: longer phrases first so "pharmaceutical" isn't half-
    // consumed by the "co" word-boundary match.
    .replace(/\bpharmaceuticals\b/g, " ")
    .replace(/\bpharmaceutical\b/g, " ")
    .replace(/\bpharma\b/g, " ")
    .replace(/\btherapeutics\b/g, " ")
    .replace(/\bbiopharma\b/g, " ")
    .replace(/\bsciences\b/g, " ")
    .replace(/\blabs\b/g, " ")
    .replace(/\blaboratories\b/g, " ")
    .replace(/\bcorp(?:oration)?\b/g, " ")
    .replace(/\bincorporated\b/g, " ")
    .replace(/\binc\b/g, " ")
    .replace(/\bllc\b/g, " ")
    .replace(/\bltd\b/g, " ")
    .replace(/\bplc\b/g, " ")
    .replace(/\bco\b/g, " ")
    .replace(/\bag\b/g, " ")
    .replace(/\bsa\b/g, " ")
    .replace(/\bnv\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface WatchlistRow {
  symbol: string;
  name: string;
  /** Used by the source module to filter to Healthcare; pure module
   *  doesn't enforce it but accepts it for forward-compat. */
  sector?: string;
}

/**
 * Find the watchlist symbol (if any) that this openFDA applicant
 * belongs to. Returns null when no confident match is found.
 *
 * Tier 1: KNOWN_FDA_APPLICANTS — exact-after-normalisation match
 * against the hand-curated map. Hits return the ticker immediately
 * with full confidence.
 *
 * Tier 2: token-containment match — normalise both sides, require
 * the watchlist company's largest token (≥ minMatchTokenLength) to
 * appear in the applicant's normalised string. Conservative: a name
 * like "Apple Inc" normalises to "apple", which has length 5 ≥ 4,
 * but Apple isn't in our watchlist's Healthcare sector anyway — so
 * it never reaches this code path in practice.
 *
 * Bias: false negatives over false positives. When two watchlist
 * rows could both plausibly match, return null rather than pick one
 * arbitrarily.
 */
export function findWatchlistMatch(
  applicantName: string,
  watchlist: WatchlistRow[],
  cfg: FdaConfig = FDA_CONFIG
): WatchlistRow | null {
  const normApplicant = normaliseApplicantName(applicantName);
  if (normApplicant === "") return null;

  // Tier 1: known map. Iterate the watchlist so we only return a
  // ticker that's actually in the user's universe.
  for (const row of watchlist) {
    const knownStrings = KNOWN_FDA_APPLICANTS[row.symbol];
    if (!knownStrings) continue;
    for (const known of knownStrings) {
      if (normaliseApplicantName(known) === normApplicant) {
        return row;
      }
      // Also accept "known applicant is a substring of openFDA's
      // applicant string" — handles "MERCK SHARP & DOHME CORP" when
      // we only have "MERCK SHARP & DOHME" listed, etc.
      if (
        normaliseApplicantName(known).length > 0 &&
        normApplicant.includes(normaliseApplicantName(known))
      ) {
        return row;
      }
    }
  }

  // Tier 2: token-containment match across watchlist names.
  const candidates: WatchlistRow[] = [];
  for (const row of watchlist) {
    const normName = normaliseApplicantName(row.name);
    if (normName === "") continue;
    // Largest token in the watchlist name — the "anchor". For "Vertex
    // Pharmaceuticals" this is "vertex". For very short names like
    // "Co" (which shouldn't exist), the anchor is below the minimum.
    const anchor = normName
      .split(/\s+/)
      .filter((t) => t.length >= cfg.minMatchTokenLength)
      .sort((a, b) => b.length - a.length)[0];
    if (!anchor) continue;
    // Use whole-word containment to avoid "merck" matching
    // "merckhausen". Surround with spaces and search.
    const haystack = ` ${normApplicant} `;
    const needle = ` ${anchor} `;
    if (haystack.includes(needle)) {
      candidates.push(row);
    }
  }

  // Strict ambiguity rule: when more than one candidate matches,
  // refuse to pick (false positive risk). Caller logs and skips.
  if (candidates.length === 1) return candidates[0];
  return null;
}

interface FdaEventLite {
  /** ISO date string of the approval. */
  date: string;
  /** Human-readable description for the UI tooltip. */
  description: string;
}

/**
 * Build the `FdaActivity` shape that goes onto an Analysis from the
 * persisted rows for one symbol. Pure: given the rows, deterministic
 * output. `now` is injected for testability.
 */
export function evaluateFdaActivity(
  events: FdaEventLite[],
  now: Date = new Date(),
  cfg: FdaConfig = FDA_CONFIG
): FdaActivity {
  if (events.length === 0) {
    return {
      hasRecentApproval: false,
      lastApprovalAt: null,
      description: "",
    };
  }
  const dayMs = 86_400_000;
  const cutoff = now.getTime() - cfg.approvalWindowDays * dayMs;
  // Sort descending so [0] is the most recent.
  const sorted = events
    .slice()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const mostRecent = sorted[0];
  const mostRecentMs = new Date(mostRecent.date).getTime();
  const hasRecentApproval =
    Number.isFinite(mostRecentMs) && mostRecentMs >= cutoff;
  return {
    hasRecentApproval,
    lastApprovalAt: Number.isFinite(mostRecentMs)
      ? new Date(mostRecentMs).toISOString()
      : null,
    description: hasRecentApproval ? mostRecent.description : "",
  };
}

// Re-export the known map's read-only view so tests + edge module
// can introspect it (e.g. "is this ticker in the curated list?").
export const KNOWN_FDA_APPLICANTS_LIST: Readonly<Record<string, readonly string[]>> =
  KNOWN_FDA_APPLICANTS;
