"use client";

export function ScoreGauge({ score }: { score: number }) {
  const normalized = (score + 100) / 200;
  const hue = normalized * 120; // 0=red, 60=yellow, 120=green
  const color = `hsl(${hue}, 80%, 55%)`;

  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 rounded-full bg-white/5 relative overflow-hidden">
        <div
          className="absolute left-0 top-0 h-full rounded-full transition-all duration-500"
          style={{ width: `${normalized * 100}%`, background: color }}
        />
      </div>
      <span
        className="text-xs font-bold tabular-nums"
        style={{ color }}
      >
        {score > 0 ? "+" : ""}
        {score}
      </span>
    </div>
  );
}

export function SignalBadge({
  type,
  label,
}: {
  type: "buy" | "sell" | "neutral";
  label: string;
}) {
  const styles = {
    buy: "bg-emerald-500/15 border-emerald-500/30 text-emerald-400",
    sell: "bg-rose-500/15 border-rose-500/30 text-rose-400",
    neutral: "bg-slate-500/10 border-slate-500/25 text-slate-400",
  };

  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold border mr-1 mb-1 ${styles[type]}`}
    >
      {label}
    </span>
  );
}

export function RecommendationBadge({
  recommendation,
  score,
}: {
  recommendation: string;
  score: number;
}) {
  const color =
    score >= 40
      ? "text-emerald-400"
      : score >= 15
        ? "text-emerald-300"
        : score > -15
          ? "text-amber-400"
          : score > -40
            ? "text-orange-400"
            : "text-rose-400";

  return (
    <span className={`text-xs font-bold ${color}`}>{recommendation}</span>
  );
}
