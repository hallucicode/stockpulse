"use client";

// Phase 14 — structured trade card.
//
// Replaces the badge-soup `StockCard` layout in `scanner-view.tsx` with a
// labelled-row layout that's faster to scan. Each row is hidden when its
// underlying signal is absent, so the card auto-shrinks for stocks with
// thin data (no options chain, no news diagnosis, etc).
//
// Composition:
//   - Header        : symbol, recommendation badge, score, regime + ✓/⚠
//   - Why cheap?    : derived rationale (trade-rationale.ts)
//   - Catalysts     : present catalyst types, inline (Phase 7 data)
//   - Options       : IV rank + P/C (Phase 8 data)
//   - Diagnosis     : non-technical diagnosis chip (Phase 4 data)
//   - Entry/Stop/Target + R:R   (Phase 1 data)
//   - Size          : risk-based shares + dollar + portfolio %  (Phase 14)
//   - Confidence    : ★/☆ stars  (Phase 7 data)
//   - Copy ticket   : plain-text clipboard button  (Phase 14)
//
// Tax row from the spec was intentionally dropped — Phase 13 established that
// the user is NL Box 3, where per-trade holding period is irrelevant.
//
// Pure presentation; all math comes from the pure helpers.

import { useStore, type ScannerStock } from "@/hooks/use-store";
import { ScoreGauge, RecommendationBadge } from "./indicators";
import { computePositionSize } from "@/lib/position-sizing";
import { buildWhyCheap } from "@/lib/trade-rationale";
import { regimeFitsSignal } from "@/lib/regime-compatibility";
import { OPTIONS_CONFIG, RISK_CONFIG } from "@/lib/config";
import { toast } from "sonner";
import { log } from "@/lib/logger";
import type { CatalystType, DiagnosisInfo } from "@/types";

// Local copy of the catalyst-type → label map. Two copies (here + scanner-view)
// is tolerable; if a third consumer needs it, extract to a shared module.
const CATALYST_LABEL: Record<CatalystType, string> = {
  earnings_upcoming: "Earnings",
  insider_cluster: "Insider cluster",
  analyst_upgrade: "Upgrade",
  positive_news: "Positive news",
  sector_rotation: "Sector turning",
  fda_event: "FDA approval",
};

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

const REGIME_LABEL: Record<NonNullable<ScannerStock["analysis"]["regime"]>["regime"], string> = {
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
    const cats = a.catalysts.present.map((c) => CATALYST_LABEL[c]).join(", ");
    lines.push(`Catalysts: ${cats}`);
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
      log.warn("trade-card", "copy.failure", { symbol: stock.symbol, error: err });
      toast.error("Failed to copy trade ticket");
    }
  };

  const goToDetail = () => {
    setSelectedSymbol(stock.symbol);
    setView("detail");
  };

  const catalystLine =
    a.catalysts && a.catalysts.confidence > 0
      ? a.catalysts.present
          .map((c) => CATALYST_LABEL[c])
          .join(" · ")
      : null;

  const optionsLine =
    a.options && a.options.atmIV !== null
      ? (() => {
          const ivPct = (a.options.atmIV ?? 0) * 100;
          const rankLabel =
            a.options.ivRank === null
              ? "rank pending"
              : `rank ${a.options.ivRank.toFixed(0)}`;
          const rankFlavour =
            a.options.ivRank === null
              ? ""
              : a.options.ivRank < OPTIONS_CONFIG.ivRankLowPercentile
                ? " — cheap"
                : a.options.ivRank > OPTIONS_CONFIG.ivRankHighPercentile
                  ? " — expensive"
                  : "";
          const pcr =
            a.options.putCallRatio === null
              ? ""
              : ` · P/C ${a.options.putCallRatio.toFixed(2)}`;
          return `IV ${ivPct.toFixed(0)}% (${rankLabel}${rankFlavour})${pcr}`;
        })()
      : null;

  const diagnosisLabel =
    a.diagnosis && DIAGNOSIS_LABEL[a.diagnosis.category]
      ? DIAGNOSIS_LABEL[a.diagnosis.category]
      : null;

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
          <div className="text-[11px] text-slate-500 truncate">{stock.name}</div>
          {a.regime && (
            <div className="text-[10px] text-slate-500 mt-1">
              <span>Regime: {REGIME_LABEL[a.regime.regime]}</span>{" "}
              {fit.ok ? (
                <span className="text-emerald-400" aria-label="regime fits signal">
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
        {catalystLine && <Row label="Catalysts">{catalystLine}</Row>}
        {optionsLine && <Row label="Options">{optionsLine}</Row>}
        {diagnosisLabel && <Row label="Diagnosis">{diagnosisLabel}</Row>}
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
