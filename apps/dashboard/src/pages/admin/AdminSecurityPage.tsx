/**
 * Standalone admin console: Security. The administrator's passkeys, adding one on this
 * device, and removing one. A passkey is unlocked on the device (fingerprint, face, PIN
 * or a hardware key) and cannot be phished, so with one registered a stolen mailbox is
 * no longer enough to get in.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { PageHeader } from "../../components/page-header.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { passkeysSupported, useAddPasskey, useAdminMe, useAdminPasskeys, useRemovePasskey } from "../../admin-auth.js";
import { lastUsedLabel, suggestPasskeyName } from "../../passkey-ui.js";
import { Notice, Section, errorMessage } from "../settings/shared.js";

export default function AdminSecurityPage() {
  const { data: me } = useAdminMe();
  const list = useAdminPasskeys();
  const add = useAddPasskey();
  const remove = useRemovePasskey();
  const [name, setName] = useState(() => suggestPasskeyName(typeof navigator === "undefined" ? "" : navigator.userAgent));
  const [confirming, setConfirming] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const mode = me?.passkey_mode ?? "optional";
  const passkeys = list.data ?? [];
  const supported = passkeysSupported();

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Platform" title="Security" subtitle="How you sign in to the admin console." />

      {mode === "enforced" && (
        <Notice variant="info">Passkeys are required here: once you have one, an emailed link no longer signs you in. Keep at least two, on different devices.</Notice>
      )}
      {mode === "optional" && passkeys.length === 0 && list.isSuccess && (
        <Notice variant="warning">You have no passkey yet. Today anyone who can read your email can sign in as you. Add one below.</Notice>
      )}

      <Section
        title="Passkeys"
        description="A passkey lives on your device and is unlocked with your fingerprint, face, PIN or a hardware key. It only works on this console's real address, so a look-alike site cannot use it."
        configured={null}
      >
        {list.isLoading && <Skeleton className="h-16 w-full" />}
        {list.isError && <Notice>{errorMessage(list.error)}</Notice>}

        {list.isSuccess && passkeys.length === 0 && <p className="text-[14px] text-muted-foreground">No passkeys registered.</p>}
        <ul className="divide-y divide-border">
          {passkeys.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <KeyRound size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-medium text-foreground">{p.name}</p>
                  <p className="text-[13px] text-muted-foreground">
                    Added {new Date(p.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })} &middot; {lastUsedLabel(p.last_used_at)}
                    {p.backed_up && " · synced across your devices"}
                  </p>
                </div>
              </div>
              {confirming === p.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-[14px] text-muted-foreground">Remove this passkey?</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(p.id, { onSettled: () => setConfirming(null) })}
                  >
                    Yes, remove
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                    Keep it
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" aria-label={`Remove ${p.name}`} onClick={() => setConfirming(p.id)}>
                  <Trash2 aria-hidden="true" /> Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
        {remove.isError && <p className="mt-2 text-[14px] text-danger">{errorMessage(remove.error)}</p>}
      </Section>

      <Section title="Add a passkey" description="Register this device. You will be asked to confirm with your fingerprint, face, PIN or security key." configured={null}>
        {!supported ? (
          <Notice variant="warning">This browser or device does not support passkeys. Try a recent version of Chrome, Edge, Safari or Firefox, and make sure the page is on https (or localhost).</Notice>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setAdded(false);
              add.mutate(name.trim(), { onSuccess: () => setAdded(true) });
            }}
          >
            <label className="block max-w-sm">
              <span className="text-[14px] text-foreground">Name (so you can tell your devices apart)</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="mt-1" />
            </label>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? "Waiting for your device..." : "Add a passkey"}
            </Button>
            {add.isError && <p className="text-[14px] text-danger">{errorMessage(add.error)}</p>}
            {added && !add.isPending && !add.isError && <p className="text-[14px] text-success">Passkey added. <Badge variant="success">Ready</Badge></p>}
          </form>
        )}
      </Section>
    </div>
  );
}
