import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./site.css";
import "./polish.css";
import AppShell from "@/components/AppShell";

export const metadata: Metadata = {
  title: "EcoVital — Your air, explained out loud",
  description: "EcoVital pods watch dust, air quality, temperature and humidity in your rooms, speak what to do, and show every room in one app.",
  manifest: "/manifest.json",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0F6B2A" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
