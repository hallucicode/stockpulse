import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "StockPulse — Volatile Stock Scanner",
  description: "Catch tops and bottoms on volatile stocks with technical analysis signals",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Toaster
          theme="dark"
          position="top-right"
          toastOptions={{
            style: {
              background: "#0f1420",
              border: "1px solid rgba(255,255,255,0.06)",
              color: "#e2e8f0",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "12px",
            },
          }}
        />
        {children}
      </body>
    </html>
  );
}
