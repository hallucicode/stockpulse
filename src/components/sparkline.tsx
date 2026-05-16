"use client";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  showArea?: boolean;
}

export function Sparkline({
  data,
  width = 200,
  height = 48,
  color = "#22d3ee",
  showArea = true,
}: SparklineProps) {
  if (!data || data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 2;

  const points = data.map(
    (v, i) =>
      `${(i / (data.length - 1)) * width},${
        height - ((v - min) / range) * (height - pad * 2) - pad
      }`
  );

  const polyline = points.join(" ");
  const gradientId = `spark-${color.replace("#", "")}-${width}`;

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {showArea && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.2" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d={`M0,${height} L${points.map((p) => p).join(" L")} L${width},${height} Z`}
            fill={`url(#${gradientId})`}
          />
        </>
      )}
      <polyline
        points={polyline}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
