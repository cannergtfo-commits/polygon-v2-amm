import type { Metadata } from "next";
import { JetBrains_Mono, Sora, Syne } from "next/font/google";
import { Providers } from "@/components/providers";
import { Shell } from "@/components/shell";
import "./globals.css";

const sora = Sora({ subsets: ["latin"], variable: "--font-sora" });
const syne = Syne({ subsets: ["latin"], variable: "--font-syne" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "BlazarSwap v2",
  description: "Polygon aggregator for BlazarBits. 0.05% fee, points, daily BZB board, and BZB staking.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${sora.variable} ${syne.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
