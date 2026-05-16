// Phase 4 — news diagnosis (pure module).
//
// Pure per CLAUDE.md "Pure core, side effects at edges": this file decides,
// given a list of headlines, *what category* the most relevant news falls
// into and how much to nudge the technical score.
//
// Approach: keyword regex over headlines. Cheap, deterministic, explainable.
// The plan calls for a Claude Haiku LLM fallback for `unknown` cases —
// deliberately deferred for v1 (would add an external dependency + cost
// and is not required to demonstrate the pipeline).
//
// Rules walk in `RULES` order; the first rule that matches wins. Order is
// chosen so more specific / more severe categories take precedence:
//   fraud > lawsuit > guidance_cut > earnings_miss > merger > product_launch >
//   sector_selloff
//
// Each rule's `scoreAdjustment` comes from `NEWS_CONFIG.scoreAdjustments`
// — single source of truth, easy to retune from backtest data later.

import type {
  Analysis,
  DiagnosisCategory,
  DiagnosisInfo,
} from "@/types";
import { NEWS_CONFIG, RECOMMENDATION_THRESHOLDS } from "./config";

interface Rule {
  category: Exclude<DiagnosisCategory, "technical_only" | "unknown">;
  patterns: RegExp[];
}

// Severity-ordered. First match wins. Order roughly = "most diagnostic
// first" — fraud trumps everything; analyst_upgrade comes after the negative
// categories so an upgrade-after-bad-news headline gets the bad-news label.
//
// Each rule's patterns are intentionally specific. A regex that's too broad
// (matching the word "approve" anywhere) would create false positives the
// user can't easily diagnose. When in doubt, leave it as `unknown` — a
// silent miss is better than a confidently-wrong category.
const RULES: ReadonlyArray<Rule> = [
  // ─── Severe negatives ─────────────────────────────────────────────
  {
    category: "fraud",
    patterns: [
      /\bfraud\b/i,
      /sec\s+(investigation|charges|complaint|enforcement)/i,
      /accounting\s+(irregularit|scandal)/i,
      /\brestat(e|es|ed|ing)\b.*(earnings|results|financials)/i,
      /financial\s+misconduct/i,
      /\bprobe\b|\binvestigation\b/i,
    ],
  },
  {
    category: "guidance_cut",
    patterns: [
      /\b(cut|cuts|cutting|lowered|lowers|reduced|reduces|slashed|slashes)\b[\w\s-]{0,40}?\b(guidance|outlook|forecast)\b/i,
      /\b(guidance|outlook|forecast)\b[\w\s-]{0,40}?\b(cut|lowered|reduced|slashed|disappoints?)\b/i,
      /below\s+(prior|previous)\s+guidance/i,
      /warn(s|ed|ing)?\s+of\s+(lower|weak|weaker)/i,
      /narrow(s|ed|ing)?\s+(\w+\s+){0,3}guidance/i,
    ],
  },
  {
    category: "lawsuit",
    patterns: [
      /class[-\s]action/i,
      /\blawsuit\b/i,
      /\bsued\b/i,
      /\blitigation\b/i,
      /\bsettlement\b/i,
      /\bantitrust\b/i,
    ],
  },
  {
    category: "regulatory_setback",
    patterns: [
      /(fda|ema|cfpb|doj)\s+reject/i,
      /\brecall(s|ed|ing)?\b/i,
      /clinical\s+trial\s+(fail|failure|failed|halted|stopped|suspended)/i,
      /phase\s+(1|2|3|i|ii|iii)\s+(fail|failure|failed|missed)/i,
      /complete\s+response\s+letter/i,
    ],
  },
  {
    category: "dividend_cut",
    patterns: [
      /(dividend|payout)\s+(cut|cuts|cutting|reduced|reduces|slashed|slashes|suspended|suspends|eliminat\w+)/i,
      /(cut|cuts|cutting|lower(s|ed)?|reduce(s|d)?|slashe?(s|d)?|suspend(s|ed)?)\s+(\w+\s+){0,3}(dividend|payout)/i,
      /(omits?|skips?)\s+(\w+\s+){0,3}dividend/i,
    ],
  },
  {
    category: "earnings_miss",
    patterns: [
      /miss(es|ed)?\s+(estimates?|expectations?|consensus|q\d)/i,
      /earnings\s+miss\b/i,
      /below\s+(expectations?|estimates?|consensus)/i,
      /(disappointing|weaker[-\s]than[-\s]expected)\s+(earnings|results|revenue|quarter)/i,
      /\b(eps|revenue)\s+(miss(es|ed)?|fall(s|n)?\s+short)/i,
      /shy\s+of\s+(estimates?|consensus)/i,
    ],
  },
  // ─── Moderate negatives ───────────────────────────────────────────
  {
    category: "analyst_downgrade",
    patterns: [
      /\bdowngrade(s|d)?\b/i,
      /\b(cut|cuts|lowered|lowers|reduced|reduces|trims?|trimmed)\s+(\w+\s+){0,3}price\s+target/i,
      /\b(price\s+target|pt)\s+(cut|lowered|reduced|trimmed)/i,
      /\b(rating|recommendation)\s+(cut|lowered|reduced)/i,
      /\b(neutral|sell|underweight|underperform|hold)\s+from\s+(buy|hold|outperform|overweight)/i,
    ],
  },
  {
    category: "layoffs",
    patterns: [
      /\blayoff(s|ed|ing)?\b/i,
      /workforce\s+reduction/i,
      /job\s+cut(s|ting)?/i,
      /restructur(e|ed|es|ing)/i,
      /\bcost[-\s]cutting\b/i,
    ],
  },
  // ─── Neutral ──────────────────────────────────────────────────────
  {
    category: "leadership_change",
    patterns: [
      /\b(ceo|cfo|coo|cto|chairman|president)\s+(steps|stepping|to\s+step)\s+down/i,
      /resign(s|ed|ation)?\s+as\s+(ceo|cfo|coo|cto|chairman|president)/i,
      /\b(names|appoints|hires|taps)\s+(\w+\s+){0,4}(ceo|cfo|coo|cto|chairman|president)/i,
      /new\s+(ceo|cfo|coo|cto|chairman|president)\b/i,
      /(ceo|cfo|coo|cto)\s+(departure|exit|to\s+leave|leaving)/i,
    ],
  },
  {
    category: "merger",
    patterns: [
      /\bmerger\b/i,
      /\bacquir(es?|ed|ing|ition)\b/i,
      /takeover\s+(bid|offer)/i,
      // Note: deliberately NOT matching bare "to buy" / "to acquire" —
      // "upgrades stock to Buy" would mis-fire here. Acquisition headlines
      // are well-covered by the `acquir(...)` family above.
      /\bspin[-\s]?off\b/i,
      /\bbuyout\b/i,
    ],
  },
  // ─── Mild positives ───────────────────────────────────────────────
  {
    category: "buyback",
    patterns: [
      /\b(share\s+)?(buyback|repurchase)/i,
      /\$\d+[\w.]*\s+(buyback|repurchase)/i,
      /authoriz(e|es|ed)\s+(\w+\s+){0,3}(repurchase|buyback)/i,
    ],
  },
  {
    category: "dividend_hike",
    patterns: [
      /(dividend|payout)\s+(hike|hikes|hiked|raise|raises|raised|increase|increases|increased|boost|boosts|boosted)/i,
      /(raises?|raised|hike(s|d)?|boost(s|ed)?|increase(s|d)?)\s+(\w+\s+){0,3}(dividend|payout|distribution)/i,
      /declares?\s+special\s+dividend/i,
    ],
  },
  {
    category: "partnership",
    patterns: [
      /\bpartnership\b/i,
      /strategic\s+(deal|agreement|alliance|partnership)/i,
      /joint\s+venture/i,
      /signs?\s+(\w+\s+){0,3}(deal|agreement|contract)\s+with/i,
      /collaboration\s+(with|agreement)/i,
    ],
  },
  {
    category: "product_launch",
    patterns: [
      /\blaunch(es|ed|ing)?\b/i,
      /\bunveil(s|ed|ing)?\b/i,
      /announces\s+(new|next[-\s]gen)/i,
      /\bdebuts?\b/i,
      /\bintroduces?\b/i,
      /rolls?\s+out\b/i,
    ],
  },
  {
    category: "sector_selloff",
    patterns: [
      /sector[-\s]wide\s+(sell[-\s]?off|drop|decline|rout)/i,
      /broad\s+market\s+(decline|sell[-\s]?off)/i,
      /(tech|bank|energy|healthcare|reit)\s+stocks\s+(slump|fall|tumble|drop)/i,
    ],
  },
  // ─── Strong positives ─────────────────────────────────────────────
  {
    category: "earnings_beat",
    patterns: [
      /\bbeats?\s+(estimates?|expectations?|consensus|q\d|street)/i,
      /\btops?\s+(estimates?|expectations?|consensus|q\d)/i,
      /better[-\s]than[-\s]expected\s+(earnings|results|revenue|quarter)/i,
      /\b(eps|revenue)\s+beats?\b/i,
      /earnings\s+beat\b/i,
    ],
  },
  {
    category: "analyst_upgrade",
    patterns: [
      /\bupgrade(s|d)?\b/i,
      /\b(raise(s|d)?|raised|hike(s|d)?|boost(s|ed)?|increase(s|d)?)\s+(\w+\s+){0,3}price\s+target/i,
      /\b(price\s+target|pt)\s+(raised|increased|boosted)/i,
      /\b(rating|recommendation)\s+(raised|upgraded|increased)/i,
      /(buy|outperform|overweight|strong\s+buy)\s+from\s+(neutral|hold|sell|underweight|underperform)/i,
      /\binitiates?\s+(\w+\s+){0,8}(buy|outperform|overweight)\b/i,
    ],
  },
  {
    category: "regulatory_approval",
    patterns: [
      /(fda|ema|ce\s+mark|cfpb)\s+approv(es|ed|al)/i,
      /phase\s+(2|3|ii|iii)\s+(success|positive|primary\s+endpoint\s+met)/i,
      /clinical\s+trial\s+success/i,
      /breakthrough\s+therapy\s+designation/i,
    ],
  },
  // ─── Informational (neutral, score 0) ─────────────────────────────
  // These intentionally come last — they're broad catch-alls for
  // recognised news shapes that aren't catalysts. Anything matching here
  // is a "we saw it, it's not actionable" rather than the more confusing
  // "unknown".
  {
    category: "earnings_report",
    patterns: [
      /q\d\s+(\d{4})?\s*(earnings|results)\s+call\s+transcript/i,
      /q\d\s+(\d{4})?\s*-\s*(results|earnings)/i,
      /reports?\s+q\d\s+(\d{4})?\s*(earnings|results)/i,
      /\bearnings\s+call\s+(transcript|presentation|preview|webcast)/i,
      /\b(q\d|first[-\s]quarter|second[-\s]quarter|third[-\s]quarter|fourth[-\s]quarter)\s+results\b/i,
    ],
  },
  {
    category: "market_wrap",
    patterns: [
      /top\s+(gainers?|losers?)/i,
      /(stocks?|stock)\s+moving\s+in/i,
      /(today|today's|wednesday's|thursday's|friday's|monday's|tuesday's)\s+(intraday|after[-\s]hours)\s+session/i,
      /most\s+active\s+stocks/i,
      /trading\s+volume\s+of\s+these\s+stocks/i,
      /why\s+\w+\s+stock\s+(is|was)\s+(sliding|skyrocketing|plummeting|soaring|jumping|tumbling|sliding|moving)/i,
      /stock\s+market\s+today/i,
    ],
  },
];

/**
 * Classify a list of recent headlines. Pure: no clock reads, no I/O.
 *
 * Empty headline list → `technical_only` (no news to explain a move).
 * No rule matches → `unknown` (we have news but can't categorize it).
 *
 * The rationale string is meant to be readable in a tooltip on the card.
 */
export function diagnoseFromNews(headlines: string[]): DiagnosisInfo {
  if (headlines.length === 0) {
    return {
      category: "technical_only",
      rationale:
        "No news in the lookback window — the move is purely technical.",
      newsCount: 0,
      scoreAdjustment:
        NEWS_CONFIG.scoreAdjustments.technical_only,
    };
  }

  for (const rule of RULES) {
    let matchedHeadline: string | null = null;
    for (const headline of headlines) {
      if (rule.patterns.some((p) => p.test(headline))) {
        matchedHeadline = headline;
        break;
      }
    }
    if (matchedHeadline) {
      const truncated =
        matchedHeadline.length > 110
          ? matchedHeadline.slice(0, 107) + "..."
          : matchedHeadline;
      return {
        category: rule.category,
        rationale: `${humanLabel(rule.category)} — "${truncated}"`,
        newsCount: headlines.length,
        scoreAdjustment: NEWS_CONFIG.scoreAdjustments[rule.category],
      };
    }
  }

  return {
    category: "unknown",
    rationale: `${headlines.length} news item${headlines.length === 1 ? "" : "s"} but none matched a known pattern.`,
    newsCount: headlines.length,
    scoreAdjustment: NEWS_CONFIG.scoreAdjustments.unknown,
  };
}

/**
 * Apply the diagnosis to an Analysis object. Pure: returns a new Analysis;
 * never mutates the input.
 *
 * Re-derives the recommendation from the adjusted score so the chip stays
 * consistent with the score after a downgrade.
 */
export function applyDiagnosisAdjustment(
  analysis: Analysis,
  diagnosis: DiagnosisInfo
): Analysis {
  if (diagnosis.scoreAdjustment === 0) {
    // Still attach the diagnosis so the UI can show "no news / sector_selloff"
    // context, but don't perturb the score or recommendation.
    return { ...analysis, diagnosis };
  }
  const newScore = clampScore(
    analysis.compositeScore + diagnosis.scoreAdjustment
  );
  return {
    ...analysis,
    compositeScore: newScore,
    recommendation: scoreToRecommendation(newScore),
    diagnosis,
  };
}

function clampScore(score: number): number {
  if (score > 100) return 100;
  if (score < -100) return -100;
  return score;
}

function scoreToRecommendation(score: number): Analysis["recommendation"] {
  if (score >= RECOMMENDATION_THRESHOLDS.strongBuy) return "STRONG BUY";
  if (score >= RECOMMENDATION_THRESHOLDS.buy) return "BUY";
  if (score > RECOMMENDATION_THRESHOLDS.sell) return "HOLD";
  if (score > RECOMMENDATION_THRESHOLDS.strongSell) return "SELL";
  return "STRONG SELL";
}

function humanLabel(category: DiagnosisCategory): string {
  switch (category) {
    case "fraud":
      return "Fraud / SEC concerns";
    case "guidance_cut":
      return "Guidance cut";
    case "lawsuit":
      return "Lawsuit / litigation";
    case "regulatory_setback":
      return "Regulatory setback";
    case "dividend_cut":
      return "Dividend cut";
    case "earnings_miss":
      return "Earnings miss";
    case "analyst_downgrade":
      return "Analyst downgrade";
    case "layoffs":
      return "Layoffs / restructuring";
    case "leadership_change":
      return "Leadership change";
    case "merger":
      return "M&A activity";
    case "buyback":
      return "Share buyback";
    case "dividend_hike":
      return "Dividend hike";
    case "partnership":
      return "Partnership / deal";
    case "product_launch":
      return "Product launch";
    case "sector_selloff":
      return "Sector-wide selloff";
    case "earnings_beat":
      return "Earnings beat";
    case "analyst_upgrade":
      return "Analyst upgrade";
    case "regulatory_approval":
      return "Regulatory approval";
    case "earnings_report":
      return "Earnings report";
    case "market_wrap":
      return "Market commentary";
    case "technical_only":
      return "No news";
    case "unknown":
      return "News present (uncategorized)";
  }
}
