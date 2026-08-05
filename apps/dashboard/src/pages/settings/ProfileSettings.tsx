/**
 * Settings / Profile.
 *
 * The signed-in user's own account: display name, role, and the
 * email-change request flow (a verification link goes to the new
 * address before anything switches).
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchProfile, updateProfile, requestEmailChange } from "../../api.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section } from "./shared.js";

export default function ProfileSettings() {
  const qc = useQueryClient();
  const profile = useQuery({ queryKey: ["profile"], queryFn: fetchProfile });
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [emailMsg, setEmailMsg] = useState<string | null>(null);

  const saveName = useMutation({
    mutationFn: (n: string | null) => updateProfile({ name: n }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["profile"] }); setEditingName(false); },
  });

  const requestEmail = useMutation({
    mutationFn: (email: string) => requestEmailChange(email),
    onSuccess: (data) => {
      setEmailMsg(data.message);
      setNewEmail("");
      qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (err) => { setEmailMsg(err instanceof Error ? err.message : "Failed"); },
  });

  const p = profile.data?.profile;

  return (
    <Section title="Profile" configured={null}>
      {profile.isLoading || !p ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[14px] text-muted-foreground">Email</p>
              <p className="mt-0.5 text-[14px] text-foreground">{p.email}</p>
              {p.pending_email && (
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Pending change to <span className="font-mono">{p.pending_email}</span> (check your inbox)
                </p>
              )}
            </div>
            <Badge variant="neutral">{p.role}</Badge>
          </div>

          {editingName ? (
            <div className="flex items-center gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Display name"
                className="max-w-xs"
              />
              <Button size="sm" onClick={() => saveName.mutate(name || null)} disabled={saveName.isPending}>
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditingName(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <p className="text-[14px] text-muted-foreground">
                Name: <span className="text-foreground">{p.name || "(not set)"}</span>
              </p>
              <Button size="sm" variant="outline" onClick={() => { setName(p.name ?? ""); setEditingName(true); }}>
                Edit
              </Button>
            </div>
          )}

          <div className="border-t border-border pt-4">
            <p className="mb-2 text-[13px] text-muted-foreground">
              Change your login email. A verification link will be sent to the new address.
            </p>
            <div className="flex items-center gap-2">
              <Input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="new@email.com"
                className="max-w-xs"
              />
              <Button
                size="sm"
                onClick={() => requestEmail.mutate(newEmail)}
                disabled={!newEmail || requestEmail.isPending}
              >
                Request change
              </Button>
            </div>
            {emailMsg && <p className="mt-2 text-[13px] text-muted-foreground">{emailMsg}</p>}
          </div>
        </div>
      )}
    </Section>
  );
}
