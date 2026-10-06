/**
 * Shown instead of the dashboard while a workspace is scheduled for deletion.
 * Everything is switched off except what matters now: download your data,
 * change your mind, or sign out. Members who are not the owner just see the date.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { Download } from "lucide-react";
import { BrandLockup } from "../components/brand-lockup.js";
import { Button, buttonVariants } from "../components/ui/button.js";
import { useLogout } from "../auth.js";
import { EXPORT_URL, timeUntilErasure, useCancelDeletion } from "../account.js";
import { cn } from "../lib/utils.js";
import { formatDay } from "../plan.js";
import { errorMessage } from "./settings/shared.js";

export default function PendingDeletionPage({ scheduledAt, isOwner }: { scheduledAt: string; isOwner: boolean }) {
  const logout = useLogout();
  const cancel = useCancelDeletion();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <BrandLockup markSize={28} />
      <h1 className="mt-8 font-display text-[24px] font-bold tracking-[-0.02em] text-foreground">This workspace is scheduled for deletion</h1>
      <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground">
        Everything will be erased for good on <strong className="text-foreground">{formatDay(scheduledAt)}</strong> ({timeUntilErasure(scheduledAt)}). Sending and the API are already switched off.
        {isOwner ? " You can still download your data, or cancel the deletion to carry on as before." : " Ask the workspace owner if you think this is a mistake."}
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        {isOwner && (
          <>
            <a href={EXPORT_URL} download className={cn(buttonVariants({ variant: "outline" }))}>
              <Download aria-hidden="true" /> Download my data
            </a>
            <Button disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              {cancel.isPending ? "Cancelling..." : "Cancel deletion"}
            </Button>
          </>
        )}
        <Button variant="ghost" disabled={logout.isPending} onClick={() => logout.mutate(undefined, { onSuccess: () => (window.location.href = "/login") })}>
          Sign out
        </Button>
      </div>
      {cancel.isError && <p className="mt-4 text-[14px] text-danger">{errorMessage(cancel.error)}</p>}
    </main>
  );
}
