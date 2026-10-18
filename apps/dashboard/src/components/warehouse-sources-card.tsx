/**
 * Data warehouse sources on the Integrate page: Loomail reads rows from your Postgres, Snowflake or BigQuery on a
 * schedule and turns them into traits and events. See ../warehouse-sources.ts for the form logic and the API's
 * warehouse/ folder for the rules.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Plus } from "lucide-react";
import {
  createWarehouseSource,
  deleteWarehouseSource,
  fetchWarehouseLog,
  fetchWarehouseSources,
  syncWarehouseSource,
  testWarehouseQuery,
  updateWarehouseSource,
  type WarehousePreview,
  type WarehouseSource,
} from "../api.js";
import {
  CREDENTIAL_HELP,
  EXAMPLE_QUERY,
  SYNC_STATE_LABEL,
  WAREHOUSE_LABEL,
  WAREHOUSE_SHORT,
  buildWarehouseConfig,
  buildWarehouseSecret,
  describeInterval,
  emptyWarehouseForm,
  syncState,
  warehouseFormFromConfig,
  type SyncState,
  type Warehouse,
  type WarehouseForm,
} from "../warehouse-sources.js";
import { LOG_STATUS_LABEL } from "../inbound-sources.js";
import { Badge, type BadgeVariant } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Select } from "./ui/select.js";
import { Textarea } from "./ui/textarea.js";

const QUERY_KEY = ["warehouse-sources"] as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const STATE_VARIANT: Record<SyncState, BadgeVariant> = { never: "neutral", running: "neutral", ok: "success", error: "danger", off: "warning" };
const LOG_VARIANT: Record<string, BadgeVariant> = { processed: "success", ignored: "neutral", rejected: "warning", error: "danger" };

function Field({ id, label, children, hint }: { id: string; label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium text-foreground" htmlFor={id}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The preview ("Test query")
// ---------------------------------------------------------------------------

function Preview({ preview }: { preview: WarehousePreview }) {
  if (!preview.ok) return <p className="mt-3 rounded-md border border-danger bg-card p-3 text-[13px] text-danger" role="alert">{preview.error}</p>;
  return (
    <div className="mt-3 rounded-md border border-border bg-card p-3" data-testid="warehouse-preview">
      <p className="text-[13px] text-foreground">
        The query works and returned {preview.rows.length === 0 ? "no rows" : `${preview.rows.length} ${preview.rows.length === 1 ? "row" : "rows"}`} to try.
        {preview.rows.length === 0 && " (Nothing matches the query yet, or the first run would start after your starting position.)"}
      </p>
      {preview.missing.length > 0 && (
        <p className="mt-2 text-[13px] text-danger" role="alert">
          The query does not return {preview.missing.length === 1 ? "this column" : "these columns"}: <strong>{preview.missing.join(", ")}</strong>. It returns:{" "}
          {preview.columns.join(", ") || "nothing"}.
        </p>
      )}
      {preview.rows.length > 0 && (
        <ul className="mt-2 space-y-2">
          {preview.rows.map((r, i) => (
            <li key={i} className="rounded border border-border bg-sunken p-2 text-[12px]">
              <p className="break-words font-mono text-muted-foreground">{preview.columns.map((c) => `${c}=${String(r.values[c])}`).join("  ")}</p>
              <p className="mt-1 break-words text-foreground">
                {r.result.ok ? (
                  <>
                    becomes <strong>{r.result.person}</strong>
                    {r.result.event ? ` with event "${r.result.event}"` : ""}
                    {Object.keys(r.result.traits).length > 0 ? `${r.result.event ? " and" : " with"} traits ${Object.entries(r.result.traits).map(([k, v]) => `${k}=${String(v)}`).join(", ")}` : ""}
                  </>
                ) : (
                  <span className="text-muted-foreground">skipped: {r.result.reason}</span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function SourceForm({ initial, onCancel, onSaved }: { initial?: WarehouseSource; onCancel: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const editing = initial !== undefined;
  const [name, setName] = useState(initial?.name ?? "");
  const [f, setF] = useState<WarehouseForm>(initial ? warehouseFormFromConfig(initial.config) : emptyWarehouseForm());
  const [problems, setProblems] = useState<string[]>([]);
  const [preview, setPreview] = useState<WarehousePreview | null>(null);
  const set = (patch: Partial<WarehouseForm>) => setF((x) => ({ ...x, ...patch }));
  const w = f.warehouse;

  const check = () => {
    const issues: string[] = [];
    if (!name.trim()) issues.push("Give the source a name.");
    const config = buildWarehouseConfig(f);
    if (!config.ok) issues.push(...config.problems);
    const secret = buildWarehouseSecret(f, editing && initial.has_credential, editing && !!initial.config.ssh_tunnel);
    if (!secret.ok) issues.push(...secret.problems);
    setProblems(issues);
    return issues.length === 0 && config.ok && secret.ok ? { config: config.value, secret: secret.value } : null;
  };

  const test = useMutation({
    mutationFn: async () => {
      const built = check();
      if (!built) throw new Error("invalid");
      return testWarehouseQuery({ ...(editing && built.secret === null ? { id: initial.id } : {}), config: built.config, ...(built.secret ? { secret: built.secret } : {}) });
    },
    onSuccess: setPreview,
    onError: (err: Error) => {
      if (err.message !== "invalid") setPreview({ ok: false, error: err.message });
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const built = check();
      if (!built) throw new Error("invalid");
      if (editing) return updateWarehouseSource(initial.id, { name: name.trim(), config: built.config, ...(built.secret ? { secret: built.secret } : {}) });
      return createWarehouseSource({ name: name.trim(), config: built.config, secret: built.secret });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      onSaved();
    },
    onError: (err: Error) => {
      if (err.message !== "invalid") setProblems([err.message]);
    },
  });

  const busy = save.isPending || test.isPending;

  return (
    <form
      className="mt-4 space-y-4 rounded-md border border-border bg-sunken p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      aria-label={editing ? "Edit warehouse source" : "Add a warehouse source"}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {!editing && (
          <Field id="wh-kind" label="Warehouse">
            <Select id="wh-kind" value={w} onChange={(e) => setF(emptyWarehouseForm(e.target.value as Warehouse))}>
              {(Object.keys(WAREHOUSE_LABEL) as Warehouse[]).map((k) => (
                <option key={k} value={k}>{WAREHOUSE_LABEL[k]}</option>
              ))}
            </Select>
          </Field>
        )}
        <Field id="wh-name" label="Name">
          <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer table" maxLength={100} />
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-[13px] font-semibold text-foreground">Connection</legend>
        {w === "postgres" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="wh-host" label={f.sshEnabled ? "Database host, as the SSH server sees it" : "Host"} hint={f.sshEnabled ? "Often a private name or address, such as db.internal or 10.0.3.7. The SSH server resolves it." : undefined}>
              <Input id="wh-host" value={f.host} onChange={(e) => set({ host: e.target.value })} placeholder={f.sshEnabled ? "db.internal" : "db.example.com"} />
            </Field>
            <Field id="wh-port" label="Port"><Input id="wh-port" inputMode="numeric" value={f.port} onChange={(e) => set({ port: e.target.value })} /></Field>
            <Field id="wh-db" label="Database"><Input id="wh-db" value={f.database} onChange={(e) => set({ database: e.target.value })} /></Field>
            <Field id="wh-user" label="User"><Input id="wh-user" value={f.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" /></Field>
            <Field id="wh-ssl" label="Encryption" hint="Leave on 'Verify the certificate' unless your database uses a self-signed one.">
              <Select id="wh-ssl" value={f.sslMode} onChange={(e) => set({ sslMode: e.target.value as WarehouseForm["sslMode"] })}>
                <option value="verify">Encrypted, verify the certificate</option>
                <option value="no-verify">Encrypted, do not verify</option>
                <option value="disable">None (only for a trusted network)</option>
              </Select>
            </Field>
            <div className="space-y-3 sm:col-span-2">
              <label className="flex items-start gap-2 text-[13px] text-foreground">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-(--accent-deep)" checked={f.sshEnabled} onChange={(e) => set({ sshEnabled: e.target.checked })} />
                <span>
                  <strong>My database is not reachable from the internet.</strong> Connect through an SSH server (a bastion) that can reach it. Loomail
                  signs in to that server with a key, and only that server needs to be reachable.
                </span>
              </label>
              {f.sshEnabled && (
                <div className="grid gap-3 rounded-md border border-border bg-card p-3 sm:grid-cols-2">
                  <Field id="wh-ssh-host" label="SSH server"><Input id="wh-ssh-host" value={f.sshHost} onChange={(e) => set({ sshHost: e.target.value })} placeholder="bastion.example.com" /></Field>
                  <Field id="wh-ssh-port" label="SSH port"><Input id="wh-ssh-port" inputMode="numeric" value={f.sshPort} onChange={(e) => set({ sshPort: e.target.value })} /></Field>
                  <Field id="wh-ssh-user" label="SSH user"><Input id="wh-ssh-user" value={f.sshUser} onChange={(e) => set({ sshUser: e.target.value })} autoComplete="off" placeholder="loomail" /></Field>
                  <div className="sm:col-span-2">
                    <Field
                      id="wh-ssh-fp"
                      label="The SSH server's host key fingerprint"
                      hint="Loomail only connects to a server with this exact key, so nobody can pose as it. Get it from a trusted machine: ssh-keyscan -t ed25519 bastion.example.com | ssh-keygen -lf -   (it prints SHA256:...)."
                    >
                      <Input id="wh-ssh-fp" value={f.sshFingerprint} onChange={(e) => set({ sshFingerprint: e.target.value })} spellCheck={false} placeholder="SHA256:..." className="font-mono text-[12px]" />
                    </Field>
                  </div>
                  <p className="text-[12px] text-muted-foreground sm:col-span-2">
                    Create a key pair for Loomail, put the public half in that user&apos;s <code className="font-mono">authorized_keys</code> (ideally with{" "}
                    <code className="font-mono">restrict,port-forwarding,permitopen=&quot;db.internal:5432&quot;</code> in front of it, so the key can do nothing else), and paste
                    the private half below. The SSH server must allow TCP forwarding.
                  </p>
                </div>
              )}
            </div>
            <div className="sm:col-span-2">
              <Field id="wh-ca" label="CA certificate (only for Amazon RDS, Supabase or a private CA)" hint="Amazon RDS and Supabase sign with their own certificate authority. Paste it here (RDS: the global bundle; Supabase: the CA from Database Settings) and Loomail still verifies the server. Neon, Redshift and most other services need nothing here.">
                <Textarea id="wh-ca" rows={3} spellCheck={false} className="font-mono text-[12px]" value={f.sslCa} onChange={(e) => set({ sslCa: e.target.value })} placeholder="-----BEGIN CERTIFICATE-----" />
              </Field>
            </div>
          </div>
        )}
        {w === "snowflake" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="wh-account" label="Account" hint="Such as myorg-myaccount or xy12345.eu-west-1"><Input id="wh-account" value={f.account} onChange={(e) => set({ account: e.target.value })} /></Field>
            <Field id="wh-user" label="User"><Input id="wh-user" value={f.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" /></Field>
            <Field id="wh-sfw" label="Warehouse (compute)"><Input id="wh-sfw" value={f.sfWarehouse} onChange={(e) => set({ sfWarehouse: e.target.value })} placeholder="COMPUTE_WH" /></Field>
            <Field id="wh-role" label="Role"><Input id="wh-role" value={f.role} onChange={(e) => set({ role: e.target.value })} placeholder="LOOMAIL_READER" /></Field>
            <Field id="wh-db" label="Database (optional)"><Input id="wh-db" value={f.database} onChange={(e) => set({ database: e.target.value })} /></Field>
            <Field id="wh-schema" label="Schema (optional)"><Input id="wh-schema" value={f.schema} onChange={(e) => set({ schema: e.target.value })} /></Field>
          </div>
        )}
        {w === "bigquery" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="wh-project" label="Project id"><Input id="wh-project" value={f.projectId} onChange={(e) => set({ projectId: e.target.value })} placeholder="my-project-123" /></Field>
            <Field id="wh-loc" label="Location (optional)" hint="Where your dataset lives, such as EU or europe-west2."><Input id="wh-loc" value={f.location} onChange={(e) => set({ location: e.target.value })} /></Field>
            <Field id="wh-gb" label="Most data one query may read (GB)" hint="A query that would read more is refused, so a mistake cannot run up a bill."><Input id="wh-gb" inputMode="decimal" value={f.maxGb} onChange={(e) => set({ maxGb: e.target.value })} /></Field>
          </div>
        )}

        <div>
          <p className="mb-1 text-[12px] text-muted-foreground">{CREDENTIAL_HELP[w]}</p>
          {w === "postgres" && (
            <div className="space-y-3">
              <Field id="wh-pw" label={`Database password${editing ? " (leave empty to keep the saved one)" : ""}`}>
                <Input id="wh-pw" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set({ password: e.target.value })} />
              </Field>
              {f.sshEnabled && (
                <>
                  <Field id="wh-ssh-key" label={`SSH private key${editing && initial?.config.ssh_tunnel ? " (leave empty to keep the saved one)" : ""}`}>
                    <Textarea id="wh-ssh-key" rows={4} spellCheck={false} autoComplete="off" className="font-mono text-[12px]" value={f.sshPrivateKey} onChange={(e) => set({ sshPrivateKey: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                  </Field>
                  <Field id="wh-ssh-pass" label="SSH key passphrase (only if the key is encrypted)">
                    <Input id="wh-ssh-pass" type="password" autoComplete="new-password" value={f.sshPassphrase} onChange={(e) => set({ sshPassphrase: e.target.value })} />
                  </Field>
                </>
              )}
            </div>
          )}
          {w === "snowflake" && (
            <div className="space-y-3">
              <Field id="wh-key" label={`Private key${editing ? " (leave empty to keep the saved one)" : ""}`}>
                <Textarea id="wh-key" rows={4} spellCheck={false} autoComplete="off" className="font-mono text-[12px]" value={f.privateKey} onChange={(e) => set({ privateKey: e.target.value })} placeholder="-----BEGIN PRIVATE KEY-----" />
              </Field>
              <Field id="wh-pass" label="Key passphrase (only if the key is encrypted)">
                <Input id="wh-pass" type="password" autoComplete="new-password" value={f.passphrase} onChange={(e) => set({ passphrase: e.target.value })} />
              </Field>
            </div>
          )}
          {w === "bigquery" && (
            <Field id="wh-sa" label={`Service-account key file${editing ? " (leave empty to keep the saved one)" : ""}`}>
              <Textarea id="wh-sa" rows={4} spellCheck={false} autoComplete="off" className="font-mono text-[12px]" value={f.serviceAccountJson} onChange={(e) => set({ serviceAccountJson: e.target.value })} placeholder='{ "type": "service_account", ... }' />
            </Field>
          )}
          <p className="mt-1 text-[12px] text-muted-foreground">Stored encrypted and never shown again.</p>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-[13px] font-semibold text-foreground">What to read</legend>
        <Field id="wh-query" label="Query">
          <Textarea id="wh-query" rows={6} spellCheck={false} className="font-mono text-[12px]" value={f.query} onChange={(e) => set({ query: e.target.value })} />
        </Field>
        <p className="text-[12px] text-muted-foreground">
          One SELECT. <code className="font-mono">:cursor</code> is where the last run got to: Loomail passes it in, and only asks for rows at or after it, so each run
          reads what is new or changed. Loomail orders the rows by the position column and limits each batch, so you need no ORDER BY or LIMIT.{" "}
          <button type="button" className="underline" onClick={() => set({ query: EXAMPLE_QUERY[w] })}>Use the example for {WAREHOUSE_SHORT[w]}</button>
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="wh-cursor" label="Position column" hint="Rises whenever a row is added or changed, such as updated_at."><Input id="wh-cursor" value={f.cursorColumn} onChange={(e) => set({ cursorColumn: e.target.value })} /></Field>
          <Field id="wh-ctype" label="It holds">
            <Select id="wh-ctype" value={f.cursorType} onChange={(e) => set({ cursorType: e.target.value as WarehouseForm["cursorType"] })}>
              <option value="timestamp">A date and time</option>
              <option value="number">A number</option>
              <option value="text">Text</option>
            </Select>
          </Field>
          <Field id="wh-start" label="Start from (optional)" hint="Empty reads everything the first time."><Input id="wh-start" value={f.initialCursor} onChange={(e) => set({ initialCursor: e.target.value })} placeholder="2026-01-01T00:00:00Z" /></Field>
          <Field id="wh-every" label="Run every (minutes)"><Input id="wh-every" inputMode="numeric" value={f.intervalMinutes} onChange={(e) => set({ intervalMinutes: e.target.value })} /></Field>
          <Field id="wh-batch" label="Rows per batch"><Input id="wh-batch" inputMode="numeric" value={f.batchSize} onChange={(e) => set({ batchSize: e.target.value })} /></Field>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-[13px] font-semibold text-foreground">What each row becomes</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="wh-uid" label="Column holding the user id"><Input id="wh-uid" value={f.userIdColumn} onChange={(e) => set({ userIdColumn: e.target.value })} /></Field>
          <Field id="wh-email" label="Column holding the email"><Input id="wh-email" value={f.emailColumn} onChange={(e) => set({ emailColumn: e.target.value })} /></Field>
          <Field id="wh-emode" label="The event">
            <Select id="wh-emode" value={f.eventMode} onChange={(e) => set({ eventMode: e.target.value as WarehouseForm["eventMode"] })}>
              <option value="fixed">Always the same name</option>
              <option value="column">Named by a column</option>
              <option value="none">No event, only set traits</option>
            </Select>
          </Field>
          {f.eventMode !== "none" && (
            <Field id="wh-evalue" label={f.eventMode === "fixed" ? "Event name" : "Column holding the event name"}>
              <Input id="wh-evalue" value={f.eventValue} onChange={(e) => set({ eventValue: e.target.value })} placeholder={f.eventMode === "fixed" ? "plan_changed" : "event_type"} />
            </Field>
          )}
          {f.eventMode !== "none" && (
            <Field id="wh-ts" label="Column holding when it happened (optional)" hint="Events older than three days are recorded as happening at sync time.">
              <Input id="wh-ts" value={f.timestampColumn} onChange={(e) => set({ timestampColumn: e.target.value })} placeholder="updated_at" />
            </Field>
          )}
        </div>
        <div>
          <p className="mb-1 text-[13px] font-medium text-foreground">Traits to set <span className="font-normal text-muted-foreground">(optional)</span></p>
          {f.traits.map((t, i) => (
            <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
              <Input aria-label={`Trait ${i + 1} name`} className="w-44" value={t.name} onChange={(e) => set({ traits: f.traits.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)) })} placeholder="plan" />
              <span className="text-[13px] text-muted-foreground">from column</span>
              <Input aria-label={`Trait ${i + 1} column`} className="w-48" value={t.column} onChange={(e) => set({ traits: f.traits.map((r, j) => (j === i ? { ...r, column: e.target.value } : r)) })} placeholder="plan" />
              <Button type="button" variant="ghost" size="sm" onClick={() => set({ traits: f.traits.filter((_, j) => j !== i) })}>Remove</Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" disabled={f.traits.length >= 30} onClick={() => set({ traits: [...f.traits, { name: "", column: "" }] })}>
            <Plus size={14} /> Add a trait
          </Button>
        </div>
        {f.eventMode !== "none" && (
          <label className="flex items-center gap-2 text-[13px] text-foreground">
            <input type="checkbox" className="h-4 w-4 accent-(--accent-deep)" checked={f.sendProperties} onChange={(e) => set({ sendProperties: e.target.checked })} />
            Keep the row&apos;s values on the event, so flows and segments can use them
          </label>
        )}
      </fieldset>

      {problems.length > 0 && (
        <ul role="alert" className="list-disc space-y-1 pl-5 text-[13px] text-danger">
          {problems.map((p) => (<li key={p}>{p}</li>))}
        </ul>
      )}
      {preview && <Preview preview={preview} />}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => test.mutate()}>
          {test.isPending ? "Testing..." : "Test the query"}
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {save.isPending ? "Saving..." : editing ? "Save changes" : "Add source"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// One source
// ---------------------------------------------------------------------------

function SourceLog({ id }: { id: string }) {
  const q = useQuery({ queryKey: [...QUERY_KEY, id, "log"], queryFn: () => fetchWarehouseLog(id), refetchInterval: 15_000 });
  if (q.isLoading) return <p className="mt-2 text-[13px] text-muted-foreground">Loading...</p>;
  if (q.isError) return <p className="mt-2 text-[13px] text-danger" role="alert">Could not load the log.</p>;
  if (!q.data || q.data.log.length === 0) return <p className="mt-2 text-[13px] text-muted-foreground">Nothing recorded yet.</p>;
  return (
    <ul className="mt-2 space-y-1.5 text-[13px]" data-testid="warehouse-log">
      {q.data.log.map((l) => (
        <li key={l.id} className="flex flex-wrap items-baseline gap-2">
          <span className="whitespace-nowrap text-muted-foreground">{when(l.created_at)}</span>
          <Badge variant={LOG_VARIANT[l.status] ?? "neutral"}>{LOG_STATUS_LABEL[l.status]}</Badge>
          <span className="text-foreground">{l.summary}</span>
        </li>
      ))}
    </ul>
  );
}

function SourceRow({ source, onEdit }: { source: WarehouseSource; onEdit: () => void }) {
  const qc = useQueryClient();
  const [showLog, setShowLog] = useState(false);
  const [confirming, setConfirming] = useState<"delete" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: QUERY_KEY });
  const fail = (e: Error) => setError(e.message);
  const toggle = useMutation({ mutationFn: () => updateWarehouseSource(source.id, { enabled: !source.enabled }), onSuccess: refresh, onError: fail });
  const remove = useMutation({ mutationFn: () => deleteWarehouseSource(source.id), onSuccess: refresh, onError: fail });
  const reset = useMutation({
    mutationFn: () => updateWarehouseSource(source.id, { reset_cursor: true }),
    onSuccess: () => {
      setConfirming(null);
      setResult("It will read everything again on the next run. Nothing is doubled.");
      void refresh();
    },
    onError: fail,
  });
  const sync = useMutation({
    mutationFn: () => syncWarehouseSource(source.id),
    onMutate: () => {
      setError(null);
      setResult(null);
    },
    onSuccess: (r) => {
      setResult(r.outcome.note);
      void refresh();
      void qc.invalidateQueries({ queryKey: [...QUERY_KEY, source.id, "log"] });
    },
    onError: fail,
  });

  const state = syncState(source);
  const warehouse = (source.config.warehouse as Warehouse) ?? "postgres";

  return (
    <li className="rounded-md border border-border bg-card p-4" data-testid={`warehouse-${source.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-medium text-foreground">{source.name}</span>
        <Badge variant="neutral">{WAREHOUSE_SHORT[warehouse] ?? "Warehouse"}</Badge>
        <Badge variant={STATE_VARIANT[state]}>{SYNC_STATE_LABEL[state]}</Badge>
        <span className="ml-auto text-[12px] text-muted-foreground">{describeInterval(source.config.interval_minutes)}</span>
      </div>
      <p className="mt-2 text-[13px] text-muted-foreground">
        {source.sync.last_at ? `Last run ${when(source.sync.last_at)}: ` : "Has not run yet. "}
        <span className={state === "error" ? "text-danger" : "text-foreground"}>{source.sync.note ?? ""}</span>
        {source.enabled && source.sync.next_at && !source.sync.running ? ` Next run ${when(source.sync.next_at)}.` : ""}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={sync.isPending || source.sync.running} onClick={() => sync.mutate()}>
          {sync.isPending ? "Syncing..." : "Sync now"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setShowLog((v) => !v)}>{showLog ? "Hide log" : "Show log"}</Button>
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>Edit</Button>
        <Button type="button" variant="outline" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate()}>{source.enabled ? "Turn off" : "Turn on"}</Button>
        {confirming === null && <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming("reset")}>Read everything again</Button>}
        {confirming === null && <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming("delete")}>Delete</Button>}
        {confirming === "reset" && (
          <span className="flex items-center gap-2 text-[13px] text-foreground">
            Start again from the beginning? Events already recorded are recognised, not doubled.
            <Button type="button" variant="destructive" size="sm" disabled={reset.isPending} onClick={() => reset.mutate()}>Start again</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
          </span>
        )}
        {confirming === "delete" && (
          <span className="flex items-center gap-2 text-[13px] text-foreground">
            Delete this source, its saved credential and its log? People and events already recorded stay.
            <Button type="button" variant="destructive" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>Delete</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
          </span>
        )}
      </div>
      {result && result !== source.sync.note && <p className="mt-2 text-[13px] text-foreground" role="status">{result}</p>}
      {error && <p className="mt-2 text-[13px] text-danger" role="alert">{error}</p>}
      {showLog && <SourceLog id={source.id} />}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export function WarehouseSourcesCard() {
  const q = useQuery({ queryKey: QUERY_KEY, queryFn: fetchWarehouseSources, refetchInterval: 30_000 });
  const [mode, setMode] = useState<{ kind: "none" } | { kind: "add" } | { kind: "edit"; id: string }>({ kind: "none" });
  const sources = q.data?.sources ?? [];
  const editing = mode.kind === "edit" ? sources.find((s) => s.id === mode.id) : undefined;

  return (
    <section className="rounded-lg border border-border bg-card p-6" aria-label="Data warehouse">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">
            <Database size={20} strokeWidth={1.5} aria-hidden="true" className="text-accent-text" />
            Data warehouse
          </h2>
          <p className="mt-2 max-w-2xl text-[14px] text-muted-foreground">
            Already keep your customer data in Postgres, Snowflake or BigQuery? Loomail reads it on a schedule and turns each row into
            traits and events, so flows and segments can use it. It only reads, and only the query you write.
          </p>
        </div>
        {mode.kind === "none" && (
          <Button size="sm" onClick={() => setMode({ kind: "add" })}>
            <Plus size={16} strokeWidth={1.5} /> Connect a warehouse
          </Button>
        )}
      </div>

      {mode.kind === "add" && <SourceForm onCancel={() => setMode({ kind: "none" })} onSaved={() => setMode({ kind: "none" })} />}
      {mode.kind === "edit" && editing && <SourceForm key={editing.id} initial={editing} onCancel={() => setMode({ kind: "none" })} onSaved={() => setMode({ kind: "none" })} />}

      {q.isLoading && <p className="mt-4 text-[13px] text-muted-foreground">Loading...</p>}
      {q.isError && <p className="mt-4 text-[13px] text-danger" role="alert">Could not load your warehouse sources.</p>}
      {q.data && sources.length === 0 && mode.kind === "none" && (
        <p className="mt-4 text-[13px] text-muted-foreground">No warehouse connected yet.</p>
      )}
      {sources.length > 0 && (
        <ul className="mt-4 space-y-3">
          {sources.map((s) => (<SourceRow key={s.id} source={s} onEdit={() => setMode({ kind: "edit", id: s.id })} />))}
        </ul>
      )}
    </section>
  );
}
