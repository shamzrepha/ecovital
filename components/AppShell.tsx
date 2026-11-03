"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type Me = { id: string; email: string; name: string; role: string };

const PUBLIC = (p: string) => p === "/" || p === "/login" || p === "/signup" || p === "/download" || p.startsWith("/share/");

const APP_NAV = [
  { href: "/dashboard", label: "Home", short: "Home", icon: "⌂" },
  { href: "/add", label: "Add pod", short: "Add", icon: "＋" },
  { href: "/insights", label: "Insights", short: "Insights", icon: "▤" },
  { href: "/ask", label: "Ask EcoVital", short: "Ask", icon: "💬" },
  { href: "/voice", label: "Voice Center", short: "Voice", icon: "🎤" },
  { href: "/settings", label: "Settings", short: "Settings", icon: "⚙" },
];

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ecovital:theme");
      if (saved === "dark" || saved === "light") {
        setTheme(saved);
        document.documentElement.setAttribute("data-theme", saved);
      } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) setTheme("dark");
    } catch {}
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("ecovital:theme", next); } catch {}
  };
  return { theme, toggle };
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const isPublic = PUBLIC(pathname);

  useEffect(() => {
    let live = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => live && setMe(j.user ?? null))
      .catch(() => live && setMe(null));
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    // Auto-sync Android Companion App FCM Token
    try {
      const bridge = (window as any).AndroidBridge;
      if (bridge?.getFcmToken) {
        const token = bridge.getFcmToken();
        if (token && typeof token === "string" && token.length > 10) {
          fetch("/api/fcm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, platform: "android" }),
          }).catch(() => {});
        }
      }
    } catch (_) {}
    return () => { live = false; };
  }, [pathname]);

  useEffect(() => {
    if (!isPublic && me === null) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    if ((pathname === "/login" || pathname === "/signup") && me) router.replace("/dashboard");
  }, [me, isPublic, pathname, router]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setMe(null);
    router.replace("/");
  }, [router]);

  const themeBtn = (
    <button type="button" className="btn small" onClick={toggle} aria-label="Toggle colour theme">
      {theme === "dark" ? "☀ Light" : "☾ Dark"}
    </button>
  );

  const brand = (href: string) => (
    <Link href={href} className="brand-link">
      <img src="/assets/logo.png" alt="" className="brand-logo" />
      <span>EcoVital</span>
    </Link>
  );

  if (isPublic) {
    return (
      <>
        <div className="app-topbar">
          <div className="app-topbar-inner">
            {brand("/")}
            <nav className="desktop-nav" aria-label="Site">
              <a className="nav-pill" href="/#how">How it works</a>
              <a className="nav-pill" href="/#features">Features</a>
              <a className="nav-pill" href="/#honest">What it measures</a>
              <a className="nav-pill" href="/#contact">Get pods</a>
              <Link className="nav-pill" href="/download">📲 App</Link>
            </nav>
            <span className="spacer" />
            <Link href="/download" className="btn small" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              📲 Get App
            </Link>
            {themeBtn}
            {me ? (
              <Link href="/dashboard" className="btn small primary">Open app</Link>
            ) : (
              <>
                <Link href="/login" className="btn small">Sign in</Link>
                <Link href="/signup" className="btn small primary">Create account</Link>
              </>
            )}
          </div>
        </div>
        {children}
        <footer className="site-footer">
          <div className="site-footer-inner">
            <span>© {new Date().getFullYear()} EcoVital</span>
            <Link href="/download" style={{ color: "inherit", textDecoration: "underline" }}>Download Android App</Link>
            <span>Dust and air readings are relative indexes, not µg/m³ or ppm.</span>
          </div>
        </footer>
      </>
    );
  }

  if (me === undefined || me === null) return <div className="skeleton" style={{ margin: 32 }}>Loading…</div>;

  const items = me.role === "admin" ? [...APP_NAV, { href: "/admin", label: "Admin", short: "Admin", icon: "⚡" }] : APP_NAV;
  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" || pathname.startsWith("/node/") : pathname.startsWith(href);

  return (
    <>
      <div className="app-topbar">
        <div className="app-topbar-inner">
          {brand("/dashboard")}
          <nav className="desktop-nav" aria-label="Primary navigation">
            {items.map((item) => (
              <Link key={item.href} href={item.href} className={`nav-pill ${isActive(item.href) ? "active" : ""}`}>
                {item.label}
              </Link>
            ))}
          </nav>
          <span className="spacer" />
          <Link
            href="/download"
            className="btn small"
            title="Download Android Companion App for Lock-Screen Siren"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            📲 Get App
          </Link>
          <span className="who" title={me.email}>{me.name}</span>
          {themeBtn}
          <button type="button" className="btn small" onClick={signOut}>Sign out</button>
        </div>
      </div>
      {children}
      <nav className="bottom-tabs" aria-label="Mobile navigation">
        {items.slice(0, 5).map((item) => (
          <Link key={item.href} href={item.href} className={`bottom-tab ${isActive(item.href) ? "active" : ""}`}>
            <span aria-hidden="true" style={{ fontSize: 15 }}>{item.icon}</span>
            <span>{item.short}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
