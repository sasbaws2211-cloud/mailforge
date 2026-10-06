/**
 * Platform admin console: the audit log. Every change an admin has made to a
 * customer workspace, newest first, with who did it, what, to which workspace,
 * and the reason they gave. Entries for deleted workspaces stay readable because
 * the workspace name is written into the entry.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { ago, auditReason, auditSummary, auditWorkspaceName, useAdminAudit } from "../../admin.js";
import { Notice, errorMessage } from "../settings/shared.js";

const SHOWN = 200;

export default function AdminAuditPage() {
  const { data, isLoading, isError, error } = useAdminAudit(SHOWN);
  return (
    <div>
      <PageHeader eyebrow="Platform" title="Audit log" subtitle={`The ${SHOWN} most recent changes admins have made, newest first.`} />
      {isError && <Notice>{errorMessage(error)}</Notice>}
      {isLoading && <Skeleton className="h-48 w-full" />}
      {data && data.entries.length === 0 && <p className="text-[14px] text-muted-foreground">No changes yet.</p>}
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {data?.entries.map((e, i) => (
          <li key={i} className="px-4 py-3 text-[14px]">
            <p className="text-foreground">
              {auditSummary(e)}
              {e.tenant_id ? (
                <>
                  {" for "}
                  <Link to={`/admin/tenants/${e.tenant_id}`} className="underline underline-offset-4">
                    {auditWorkspaceName(e) ?? "a workspace"}
                  </Link>
                </>
              ) : (
                auditWorkspaceName(e) && ` (${auditWorkspaceName(e)})`
              )}
            </p>
            <p className="text-[13px] text-muted-foreground">
              {e.actor}, {ago(e.at)}
              {auditReason(e) && `: ${auditReason(e)}`}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
