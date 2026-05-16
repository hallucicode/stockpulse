/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: "#0a0e17", card: "#0f1420", hover: "#141b2d" },
        accent: { cyan: "#22d3ee", purple: "#a78bfa" },
        bull: { DEFAULT: "#34d399", dim: "#065f46" },
        bear: { DEFAULT: "#fb7185", dim: "#881337" },
        warn: "#fbbf24",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "SF Mono", "Cascadia Code", "monospace"],
        display: ["Instrument Sans", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
