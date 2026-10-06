/**
 * The platform admin console as a page of its own.
 *
 * One frame, used two ways:
 *   - embedded: inside the customer app at /admin (default export), signed in with
 *     the person's workspace login, with a link back to their workspace
 *   - standalone: the console's own deployment (StandaloneAdminLayout), signed in
 *     with the console's own session, with a link to the customer app if configured
 *
 * Either way it is not the customer workspace shell: no workspace sidebar, no plan
 * banner, none of the workspace gates, and a clear "Admin" marker so nobody mistakes
 * it for a customer's dashboard.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useEffect, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { ArrowLeft, LogOut } from "lucide-react";
import { BrandLockup } from "../../components/brand-lockup.js";
import { ThemeToggle } from "../../components/theme-toggle.js";
import { useLogout } from "../../auth.js";
import { useAdminLogout, type AdminMe } from "../../admin-auth.js";
import { adminTabFor } from "../../admin.js";
import { cn } from "../../lib/utils.js";
import type { MeResponse } from "../../api.js";

const TABS: Array<{ id: "overview" | "ai" | "audit" | "security"; to: string; label: string }> = [
  { id: "overview", to: "/admin", label: "Overview" },
  { id: "ai", to: "/admin/ai", label: "AI providers" },
  { id: "audit", to: "/admin/audit", label: "Audit log" },
  { id: "security", to: "/admin/security", label: "Security" },
];

interface FrameProps {
  email: string;
  onSignOut: () => void;
  signingOut: boolean;
  /** A way back to the customer app. Absent means no link is shown. */
  back?: { label: string; to?: string; href?: string };
  /** The Security tab (passkeys). Only the standalone console has one. */
  showSecurity?: boolean;
  /** Something to show above the page, such as a prompt to add a passkey. */
  banner?: ReactNode;
}

function AdminFrame({ email, onSignOut, signingOut, back, showSecurity, banner }: FrameProps) {
  const { pathname } = useLocation();
  const active = adminTabFor(pathname);

  useEffect(() => {
    const before = document.title;
    document.title = "Admin console · Mailforge";
    return () => {
      document.title = before;
    };
  }, []);

  const backClass = "hidden items-center gap-1.5 text-[14px] text-muted-foreground hover:text-foreground sm:inline-flex";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="h-0.5 bg-accent" aria-hidden="true" />
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link to="/admin" className="flex items-center gap-3" aria-label="Admin console home">
            <BrandLockup markSize={22} />
            <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-text">Admin</span>
          </Link>

          <nav aria-label="Admin sections" className="order-3 flex w-full gap-1 sm:order-none sm:w-auto">
            {TABS.filter((t) => t.id !== "security" || showSecurity).map((t) => (
              <NavLink
                key={t.id}
                to={t.to}
                end
                className={cn(
                  "rounded-md px-3 py-1.5 text-[14px] font-medium transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active === t.id ? "bg-selected font-semibold text-foreground" : "text-muted-foreground hover:bg-sunken hover:text-foreground",
                )}
                aria-current={active === t.id ? "page" : undefined}
              >
                {t.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {back?.to && (
              <Link to={back.to} className={backClass}>
                <ArrowLeft size={14} aria-hidden="true" /> {back.label}
              </Link>
            )}
            {back?.href && (
              <a href={back.href} className={backClass}>
                <ArrowLeft size={14} aria-hidden="true" /> {back.label}
              </a>
            )}
            <span className="hidden max-w-[200px] truncate text-[13px] text-muted-foreground md:inline" title={email}>
              {email}
            </span>
            <ThemeToggle />
            <button
              type="button"
              onClick={onSignOut}
              disabled={signingOut}
              title={signingOut ? "Signing out..." : "Sign out"}
              aria-label="Sign out"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-subtle-foreground"
            >
              <LogOut size={16} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {banner}
        <Outlet />
      </main>
    </div>
  );
}

/** The console inside the customer app: workspace login, link back to the workspace. */
export default function AdminLayout({ me }: { me: MeResponse }) {
  const logout = useLogout();
  return (
    <AdminFrame
      email={me.user.email}
      signingOut={logout.isPending}
      onSignOut={() => logout.mutate(undefined, { onSuccess: () => (window.location.href = "/login") })}
      back={{ label: "Back to workspace", to: "/home" }}
    />
  );
}

/** The console as its own deployment: its own sign-in, optional link to the customer app. */
export function StandaloneAdminLayout({ me }: { me: AdminMe }) {
  const logout = useAdminLogout();
  return (
    <AdminFrame
      email={me.email}
      signingOut={logout.isPending}
      onSignOut={() => logout.mutate()}
      back={me.customer_url ? { label: "Customer app", href: me.customer_url } : undefined}
      showSecurity={me.passkey_mode !== "off"}
      banner={
        me.passkey_mode !== "off" && me.passkey_count === 0 ? (
          <div className="mb-6 rounded-md border border-warning bg-warning-soft px-4 py-3 text-[14px] text-foreground" role="status">
            You are signed in by email only.{" "}
            <Link to="/admin/security" className="font-medium underline underline-offset-4">
              Add a passkey
            </Link>{" "}
            to protect this console.
          </div>
        ) : undefined
      }
    />
  );
}
