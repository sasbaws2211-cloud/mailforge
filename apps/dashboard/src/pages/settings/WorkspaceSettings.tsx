/**
 * Settings / Workspace.
 *
 * Read-only identity of this install: name, slug, plan.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useSetupState } from "../../settings.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section } from "./shared.js";

export default function WorkspaceSettings() {
  const { tenant, isLoading } = useSetupState();

  return (
    <Section title="Workspace" configured={null}>
      {isLoading || !tenant ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <dl className="grid grid-cols-3 gap-4 text-[14px]">
          <div>
            <dt className="text-muted-foreground">Name</dt>
            <dd className="mt-0.5 text-foreground">{tenant.name}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Slug</dt>
            <dd className="mt-0.5 font-mono text-[13px] text-foreground">{tenant.slug}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Plan</dt>
            <dd className="mt-0.5 font-mono text-[13px] text-foreground">{tenant.plan}</dd>
          </div>
        </dl>
      )}
    </Section>
  );
}
