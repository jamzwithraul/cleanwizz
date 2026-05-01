import { Link, useLocation } from "wouter";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/components/ThemeProvider";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard,
  FileText,
  Settings,
  Sun,
  Moon,
  Menu,
  X,
  Sparkles,
  CalendarOff,
} from "lucide-react";
import { useState } from "react";

const navItems = [
  { href: "/", label: "New Quote", icon: FileText },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/availability", label: "Availability", icon: CalendarOff },
  { href: "/settings", label: "Settings", icon: Settings },
];

// Clean Wizz SVG Logo
function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-label="Clean Wizz logo"
    >
      <rect width="32" height="32" rx="7" fill="hsl(183 98% 22%)" />
      <path
        d="M7 23 L12 10 L16 17 L20 10 L25 23"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="25" cy="10" r="2" fill="#a7d8db" />
    </svg>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const { theme, toggle } = useTheme();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-64 flex flex-col bg-sidebar border-r border-sidebar-border transition-transform duration-300",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Brand */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-sidebar-border">
          <Logo size={32} />
          <div>
            <p className="font-bold text-base leading-tight text-sidebar-foreground">Clean Wizz</p>
            <p className="text-xs text-muted-foreground leading-tight">Quote Generator</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = location === href;
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileOpen(false)}
                data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <Icon size={16} />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Bottom controls */}
        <div className="px-4 py-4 border-t border-sidebar-border flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Sparkles size={13} className="text-primary" />
            <span>v1.0</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            data-testid="theme-toggle"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </Button>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile top bar */}
      <div className="fixed top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3 bg-background border-b border-border lg:hidden">
        <div className="flex items-center gap-2">
          <Logo size={24} />
          <span className="font-bold text-sm">Clean Wizz</span>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setMobileOpen(o => !o)}>
          {mobileOpen ? <X size={18} /> : <Menu size={18} />}
        </Button>
      </div>

      {/* Main content */}
      <main className="flex-1 lg:ml-64 pt-14 lg:pt-0 min-h-screen">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
