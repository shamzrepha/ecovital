"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const NAV_ITEMS = [
  { href: "/", label: "Home & Pods", short: "Home", icon: "⌂" },
  { href: "/add", label: "Add Pod", short: "Add", icon: "＋" },
  { href: "/insights", label: "Insights", short: "Insights", icon: "▤" },
  { href: "/ask", label: "Ask EcoVital", short: "Ask", icon: "💬" },
  { href: "/download", label: "Download App", short: "App", icon: "📲" },
  { href: "/settings", label: "Settings", short: "Settings", icon: "⚙" },
  { href: "/admin", label: "Admin & OTA", short: "Admin", icon: "⚡" },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("ecovital:theme") as "light" | "dark" | null;
      if (saved === "dark" || saved === "light") {
        setTheme(saved);
        document.documentElement.setAttribute("data-theme", saved);
      } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        setTheme("dark");
      }
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      }
    } catch {}
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("ecovital:theme", next);
    } catch {}
  }

  return (
    <>
      <div className="app-topbar">
        <div className="app-topbar-inner">
          <Link href="/" className="brand-link">
            <img src="/assets/logo.png" alt="EcoVital logo" className="brand-logo" />
            <div>
              <span>EcoVital</span>
              <span className="brand-tagline">Your air, explained out loud</span>
            </div>
          </Link>

          <nav className="desktop-nav" aria-label="Primary navigation">
            {NAV_ITEMS.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/" || pathname.startsWith("/node/")
                  : pathname.startsWith(item.href);
              return (
                <Link key={item.href} href={item.href} className={`nav-pill ${active ? "active" : ""}`}>
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <span className="spacer" />

          <Link href="/download" className="btn small primary" title="Download Companion App or ESP32 Firmware">
            📲 Download App
          </Link>

          <button
            type="button"
            className="btn small"
            onClick={toggleTheme}
            aria-label="Toggle colour theme"
            title="Switch between light and dark theme"
          >
            {theme === "dark" ? "☀ Light" : "☾ Dark"}
          </button>
        </div>
      </div>

      {children}

      <nav className="bottom-tabs" aria-label="Mobile navigation">
        {NAV_ITEMS.slice(0, 6).map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/" || pathname.startsWith("/node/")
              : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className={`bottom-tab ${active ? "active" : ""}`}>
              <span aria-hidden="true" style={{ fontSize: 15 }}>{item.icon}</span>
              <span>{item.short}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
