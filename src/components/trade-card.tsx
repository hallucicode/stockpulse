"use client";

// Phase 14 — structured trade card.
//
// Goal: a card that's faster to scan than the badge-soup StockCard AND
// at least as informative. Earlier draft summarised the catalyst types
// into one-line strings ("Earnings · Insider cluster · Upgrade") — that
// lost depth the StockCard had in tooltips (date, firm names, $ values).
// This version inlines that depth so the user doesn't need to hover.
//
// Composition (each row hidden when its data is absent):
//   - Header        : symbol, recommendation badge, score, regime + ✓/⚠
//   - Why cheap?    : derived rationale (trade-rationale.ts)
//   - Catalysts     : one chip per present catalyst, with rich inline detail
//   - Options       : IV rank + P/C + unusual flow flags
//   - Diagnosis     : emoji + label + rationale text
//   - Entry/Stop/Target + R:R
//   - Size          : risk-based shares + dollar + portfolio %
//   - Signals       : top-3 technical signals (buy/sell/neutral colour)
//   - Confidence    : ★/☆ stars
//   - Copy ticket   : plain-text clipboard button
//
// Tax row from the original spec was intentionally dropped — Phase 13
// established the user is NL Box 3, where per-trade holding period is
// irrelevant.

import { useStore, type ScannerStock } from "@/hooks/use-store";
import { ScoreGauge, RecommendationBadge } from "./indicators";
import { computePositionSize } from "@/lib/position-sizing";
import { buildWhyCheap } from "@/lib/trade-rationale";
import { regimeFitsSignal } from "@/lib/regime-compatibility";
import { OPTIONS_CONFIG, RISK_CONFIG } from "@/lib/config";
import { toast } from "sonner";
import { log } from "@/lib/logger";
import type {
  Analysis,
  CatalystType,
  DiagnosisInfo,
  TechnicalSignal,
} from "@/types";

// Diagnosis emoji + label, restricted to the categories where a one-liner is
// informative (i.e. not the muted `technical_only` / `market_wrap`).
const DIAGNOSIS_LABEL: Partial<Record<DiagnosisInfo["category"], string>> = {
  fraud: "🚨 Fraud allegation",
  guidance_cut: "📉 Guidance cut",
  lawsuit: "⚖️ Lawsuit",
  regulatory_setback: "🛑 Regulatory setback",
  dividend_cut: "✂️ Dividend cut",
  earnings_miss: "💔 Earnings miss",
  analyst_downgrade: "⬇️ Analyst downgrade",
  layoffs: "👋 Layoffs",
  leadership_change: "👤 Leadership change",
  merger: "🔀 M&A",
  buyback: "♻️ Buyback",
  dividend_hike: "💵 Dividend hike",
  partnership: "🤝 Partnership",
  product_launch: "🚀 Product launch",
  sector_selloff: "🌊 Sector dip",
  earnings_beat: "💚 Earnings beat",
  analyst_upgrade: "⬆️ Analyst upgrade",
  regulatory_approval: "✅ Regulatory approval",
  earnings_report: "📊 Earnings report",
};

const REGIME_LABEL: Record<
  NonNullable<ScannerStock["analysis"]["regime"]>["regime"],
  string
> = {
  trending_up: "trending up",
  trending_down: "trending down",
  ranging: "ranging",
  high_vol_crisis: "high-vol crisis",
};

interface TradeCardProps {
  stock: ScannerStock;
  /**
   * Total USD value of the user's current portfolio. When the portfolio is
   * empty, the scanner passes RISK_CONFIG.defaultPortfolioValue so the size
   * row still shows a representative example.
   */
  portfolioValueUsd: number;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span className="text-slate-500 w-20 shrink-0">{label}</span>
      <span className="text-slate-200 min-w-0">{children}</span>
    </div>
  );
}

/**
 * Format an insider-buy dollar value with k/M suffix.
 *  $4,200       → "$4k"
 *  $450,000     → "$450k"
 *  $1,200,000   → "$1.2M"
 *  $0 / negative → ""
 */
function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

/**
 * Build a rich per-catalyst chip from the actual data attached to the
 * analysis. Each chip carries the most useful single fact (date, firm,
 * value) so the row is informative without hover.
 *
 * Returns null for a catalyst type whose source data is missing — should be
 * unusual (the catalyst was added because the data existed) but we don't
 * want to render a misleading bare label like "Insider cluster" if the
 * insider object got stripped from the cache.
 */
function catalystChip(type: CatalystType, a: Analysis): string | null {
  switch (type) {
    case "earnings_upcoming": {
      if (!a.earnings) return null;
      const hour =
        a.earnings.hour === "bmo"
          ? " BMO"
          : a.earnings.hour === "amc"
            ? " AMC"
            : "";
      return `📅 Earnings ${a.earnings.daysUntil}d${hour}`;
    }
    case "insider_cluster": {
      if (!a.insiders) return null;
      const value = formatCompactUsd(a.insiders.recentBuyValueUsd);
      const tail = value ? ` (${value})` : "";
      return `👥 ${a.insiders.clusterBuyerCount} insiders${tail}`;
    }
    case "analyst_upgrade": {
      const latest = a.analysts?.latest;
      if (!latest) return null;
      // "Goldman Sachs Group Inc/The" → "Goldman Sachs" (drop legal suffix
      // when present). Keeps the chip short. Cheap heuristic; the full firm
      // name lives in the title= attribute.
      const firmShort = latest.firm.split(" Inc")[0].split(",")[0];
      const grades =
        latest.fromGrade && latest.toGrade
          ? `${latest.fromGrade}→${latest.toGrade}`
          : latest.action;
      return `⬆ ${firmShort}: ${grades}`;
    }
    case "positive_news":
      return "📰 Positive news";
    case "sector_rotation":
      if (!a.sectorRotation) return null;
      return `🔄 ${a.sectorRotation.etfSymbol} turning up`;
    case "fda_event":
      return "💊 FDA approval";
    default:
      return null;
  }
}

function buildTicketText(
  stock: ScannerStock,
  size: ReturnType<typeof computePositionSize>,
  why: string | null
): string {
  const a = stock.analysis;
  const lines: string[] = [
    `${stock.symbol} — ${a.recommendation} (score ${(a.compositeScore ?? 0).toFixed(0)})`,
  ];
  if (a.regime) {
    lines.push(`Regime: ${REGIME_LABEL[a.regime.regime]}`);
  }
  if (why) lines.push(`Why: ${why}`);
  if (a.catalysts && a.catalysts.confidence > 0) {
    const chips = a.catalysts.present
      .map((c) => catalystChip(c, a))
      .filter((s): s is string => s !== null);
    if (chips.length > 0) lines.push(`Catalysts: ${chips.join(", ")}`);
  }
  if (a.risk && a.risk.entry > 0 && a.risk.riskReward > 0) {
    lines.push(
      `Entry / Stop / Target: $${a.risk.entry.toFixed(2)} / $${a.risk.stop.toFixed(2)} / $${a.risk.target.toFixed(2)} (R:R ${a.risk.riskReward.toFixed(1)}×)`
    );
  }
  if (size) {
    lines.push(
      `Size: ${size.shares} shares ($${size.dollarValue.toLocaleString("en-US", { maximumFractionDigits: 0 })} — ${(size.portfolioPct * 100).toFixed(1)}% portfolio)`
    );
  }
  return lines.join("\n");
}

const SIGNAL_CLASS: Record<TechnicalSignal["type"], string> = {
  buy: "text-emerald-300",
  sell: "text-rose-300",
  neutral: "text-slate-400",
};
const SIGNAL_SYMBOL: Record<TechnicalSignal["type"], string> = {
  buy: "⊕",
  sell: "⊖",
  neutral: "·",
};

export function TradeCard({ stock, portfolioValueUsd }: TradeCardProps) {
  const { setView, setSelectedSymbol, portfolio } = useStore();
  const a = stock.analysis;
  const owned = portfolio.some((p) => p.symbol === stock.symbol);

  const why = buildWhyCheap(a);
  const fit = regimeFitsSignal(a.recommendation, a.regime?.regime);
  const size =
    a.risk && a.risk.entry > 0 && a.risk.stop > 0
      ? computePositionSize({
          portfolioValueUsd,
          entry: a.risk.entry,
          stop: a.risk.stop,
        })
      : null;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = buildTicketText(stock, size, why);
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Trade ticket copied");
    } catch (err) {
      log.warn("trade-card", "copy.failure", {
        symbol: stock.symbol,
        error: err,
      });
      toast.error("Failed to copy trade ticket");
    }
  };

  const goToDetail = () => {
    setSelectedSymbol(stock.symbol);
    setView("detail");
  };

  // Build the catalyst chips list. Filter out nulls (missing source data)
  // and stop rendering the row entirely when nothing remains.
  const catalystChips =
    a.catalysts && a.catalysts.confidence > 0
      ? a.catalysts.present
          .map((c) => catalystChip(c, a))
          .filter((s): s is string => s !== null)
      : [];

  // Options row builder — concatenates IV + rank + flavour + P/C + unusual
  // flags into a single inline string.
  const optionsLine = (() => {
    if (!a.options || a.options.atmIV === null) return null;
    const o = a.options;
    const ivPct = (o.atmIV ?? 0) * 100;
    const rankLabel =
      o.ivRank === null ? "rank pending" : `rank ${o.ivRank.toFixed(0)}`;
    const rankFlavour =
      o.ivRank === null
        ? ""
        : o.ivRank < OPTIONS_CONFIG.ivRankLowPercentile
          ? " — cheap"
          : o.ivRank > OPTIONS_CONFIG.ivRankHighPercentile
            ? " — expensive"
            : "";
    const pcr =
      o.putCallRatio === null
        ? ""
        : ` · P/C ${o.putCallRatio.toFixed(2)}`;
    const unusual = [
      o.unusualCalls ? "⚡ unusual calls" : null,
      o.unusualPuts ? "🛡 unusual puts" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const unusualSuffix = unusual ? ` · ${unusual}` : "";
    return `IV ${ivPct.toFixed(0)}% (${rankLabel}${rankFlavour})${pcr}${unusualSuffix}`;
  })();

  // Diagnosis row — emoji label + rationale, when the category is one we
  // care to show (not technical_only or market_wrap).
  const diagnosisLine = (() => {
    if (!a.diagnosis) return null;
    const label = DIAGNOSIS_LABEL[a.diagnosis.category];
    if (!label) return null;
    return a.diagnosis.rationale
      ? `${label} — ${a.diagnosis.rationale}`
      : label;
  })();

  // Top-3 technical signals — buy/sell/neutral coloured chips.
  const signals = a.signals?.slice(0, 3) ?? [];

  return (
    <div
      className="stock-card rounded-xl p-3.5 bg-[var(--bg-card)] cursor-pointer animate-fade-in"
      onClick={goToDetail}
    >
      {/* Header — symbol / rec / score / regime ✓ */}
      <div className="flex justify-between items-start mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[15px] font-extrabold">{stock.symbol}</span>
            <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/10 text-purple-400 tracking-wider">
              {stock.sector}
            </span>
            {owned && (
              <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-500/15 text-cyan-400 tracking-wider">
                OWNED
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 truncate">
            {stock.name}
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-[13px] font-bold">
              ${(a.price ?? 0).toFixed(2)}
            </span>
            <span
              className={`text-[11px] font-bold ${(a.dayChange ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}
            >
              {(a.dayChange ?? 0) >= 0 ? "+" : ""}
              {(a.dayChange ?? 0).toFixed(1)}%
            </span>
          </div>
          {a.regime && (
            <div className="text-[10px] text-slate-500 mt-1">
              <span>Regime: {REGIME_LABEL[a.regime.regime]}</span>{" "}
              {fit.ok ? (
                <span
                  className="text-emerald-400"
                  aria-label="regime fits signal"
                >
                  ✓
                </span>
              ) : (
                <span
                  className="text-amber-300 cursor-help"
                  title={fit.note}
                  aria-label={`regime warning: ${fit.note}`}
                >
                  ⚠
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <RecommendationBadge
            recommendation={a.recommendation}
            score={a.compositeScore ?? 0}
          />
          <ScoreGauge score={a.compositeScore ?? 0} />
        </div>
      </div>

      {/* Labelled rows */}
      <div className="flex flex-col gap-1.5 mt-2">
        {why && <Row label="Why cheap?">{why}</Row>}
        {catalystChips.length > 0 && (
          <Row label="Catalysts">
            <span
              title={
                a.analysts?.latest
                  ? `Most recent rating action: ${a.analysts.latest.firm} ${a.analysts.latest.action} on ${new Date(a.analysts.latest.date).toLocaleDateString()}`
                  : undefined
              }
            >
              {catalystChips.join(" · ")}
            </span>
          </Row>
        )}
        {optionsLine && (
          <Row label="Options">
            <span
              title={
                a.options
                  ? `ATM IV ${((a.options.atmIV ?? 0) * 100).toFixed(1)}% · Call vol ${a.options.callVolume.toLocaleString()} / OI ${a.options.callOpenInterest.toLocaleString()} · Put vol ${a.options.putVolume.toLocaleString()} / OI ${a.options.putOpenInterest.toLocaleString()}`
                  : undefined
              }
            >
              {optionsLine}
            </span>
          </Row>
        )}
        {diagnosisLine && <Row label="Diagnosis">{diagnosisLine}</Row>}
        {a.risk && a.risk.entry > 0 && a.risk.riskReward > 0 && (
          <Row label="Entry/Stop">
            <span className="font-mono">
              ${a.risk.entry.toFixed(2)}
              {" / "}
              <span className="text-rose-400">${a.risk.stop.toFixed(2)}</span>
              {" / "}
              <span className="text-emerald-400">
                ${a.risk.target.toFixed(2)}
              </span>{" "}
              <span className="text-cyan-400">
                R:R {a.risk.riskReward.toFixed(1)}×
              </span>
            </span>
          </Row>
        )}
        {size && (
          <Row label="Size">
            <span>
              {size.shares} shares ($
              {size.dollarValue.toLocaleString("en-US", {
                maximumFractionDigits: 0,
              })}
              ) — {(size.portfolioPct * 100).toFixed(1)}% portfolio
              {size.cappedByPositionLimit && (
                <span
                  className="text-amber-300 ml-1"
                  title={`Capped at ${(RISK_CONFIG.maxPositionPct * 100).toFixed(0)}% portfolio limit`}
                >
                  (capped)
                </span>
              )}
            </span>
          </Row>
        )}
        {signals.length > 0 && (
          <Row label="Signals">
            <span>
              {signals.map((s, i) => (
                <span key={i} className={SIGNAL_CLASS[s.type]} title={s.detail}>
                  {SIGNAL_SYMBOL[s.type]} {s.label}
                  {i < signals.length - 1 && (
                    <span className="text-slate-600"> · </span>
                  )}
                </span>
              ))}
            </span>
          </Row>
        )}
        {a.catalysts && a.catalysts.confidence > 0 && (
          <Row label="Confidence">
            <span className="text-amber-300/90 tracking-wider">
              {"★".repeat(a.catalysts.confidence)}
              <span className="text-slate-600">
                {"☆".repeat(Math.max(0, 5 - a.catalysts.confidence))}
              </span>
            </span>
          </Row>
        )}
      </div>

      {/* Copy-ticket button */}
      <div className="mt-3 flex justify-end">
        <button
          onClick={handleCopy}
          className="px-3 py-1 rounded-md text-[10px] font-semibold bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 cursor-pointer hover:bg-cyan-500/20 transition-colors"
        >
          Copy ticket
        </button>
      </div>
    </div>
  );
}
