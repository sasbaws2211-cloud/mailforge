/**
 * Settings / Data and deletion.
 *
 * Two things the owner can always do: download everything held for the
 * workspace, and delete the workspace. Deleting asks for the workspace name,
 * switches the workspace off at once, and erases everything after a grace
 * period unless it is cancelled first.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { Download } from "lucide-react";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { useMe } from "../../auth.js";
import { EXPORT_URL, confirmationMatches, useDeletionStatus, useScheduleDeletion } from "../../account.js";
import { cn } from "../../lib/utils.js";
import { Notice, Section, errorMessage } from "./shared.js";

export default function DataSettings() {
  const { data: me } = useMe();
  const isOwner = me?.user.role === "owner";
  const { data: status, isLoading } = useDeletionStatus();
  const schedule = useScheduleDeletion();
  const [typed, setTyped] = useState("");

  return (
    <div className="space-y-6">
      <Section
        title="Export your data"
        description="Download everything held for this workspace as one JSON file: contacts, events, flows, messages, templates, knowledge base, suppressions, team and billing history. Passwords, API key hashes and provider credentials are never included."
        configured={null}
      >
        {isOwner ? (
          <a href={EXPORT_URL} download className={cn(buttonVariants({ variant: "outline" }))}>
            <Download aria-hidden="true" /> Download export
          </a>
        ) : (
          <p className="text-[14px] text-muted-foreground">Only the workspace owner can export.</p>
        )}
        <p className="mt-3 text-[13px] text-muted-foreground">Large workspaces take a moment to start downloading. You can export a few times an hour.</p>
      </Section>

      <Section
        title="Delete workspace"
        description={`Permanently erases this workspace and everything in it. Sending and the API stop straight away. You then have ${status?.grace_days ?? 7} days to change your mind; after that nothing can be recovered.`}
        configured={null}
      >
        {isLoading || !status ? (
          <Skeleton className="h-24 w-full" />
        ) : !isOwner ? (
          <p className="text-[14px] text-muted-foreground">Only the workspace owner can delete it.</p>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmationMatches(typed, status.workspace.slug) && !schedule.isPending) schedule.mutate(typed.trim());
            }}
          >
            <Notice variant="warning">
              This cannot be undone once the {status.grace_days} days are up. Download your export first. An active subscription is cancelled so you are not charged again.
            </Notice>
            <label className="block">
              <span className="text-[14px] text-foreground">
                Type <span className="font-mono text-[13px]">{status.workspace.slug}</span> to confirm
              </span>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className="mt-1 max-w-sm font-mono" />
            </label>
            <Button type="submit" variant="destructive" disabled={!confirmationMatches(typed, status.workspace.slug) || schedule.isPending}>
              {schedule.isPending ? "Scheduling..." : "Delete this workspace"}
            </Button>
            {schedule.isError && <p className="text-[14px] text-danger">{errorMessage(schedule.error)}</p>}
          </form>
        )}
      </Section>
    </div>
  );
}
