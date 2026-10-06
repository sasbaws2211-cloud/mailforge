/**
 * Shown instead of the dashboard when a platform admin has suspended the
 * workspace. Nothing is deleted; the customer is told who to contact.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { BrandLockup } from "../components/brand-lockup.js";
import { Button } from "../components/ui/button.js";
import { useLogout } from "../auth.js";

export default function SuspendedPage() {
  const logout = useLogout();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <BrandLockup markSize={28} />
      <h1 className="mt-8 font-display text-[24px] font-bold tracking-[-0.02em] text-foreground">This workspace is suspended</h1>
      <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground">
        Sign-in, sending and the API are switched off for this workspace. Your data has not been deleted. If you think this is a mistake, contact support and we will look at it.
      </p>
      <Button
        className="mt-6"
        variant="outline"
        disabled={logout.isPending}
        onClick={() => logout.mutate(undefined, { onSuccess: () => (window.location.href = "/login") })}
      >
        Sign out
      </Button>
    </main>
  );
}
