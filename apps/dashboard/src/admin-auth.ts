/**
 * Sign-in for the standalone admin console: calls to /admin-auth/* and the hooks
 * the console's pages use. Separate from the customer app's auth on purpose: a
 * different session, a different cookie, a different set of people.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { passkeyErrorMessage } from "./passkey-ui.js";

export interface AdminMe {
  email: string;
  /** Where the customer app lives, for a link back. Null when not configured. */
  customer_url: string | null;
  /** How this session was started. */
  method: "email" | "passkey";
  /** off | optional | enforced */
  passkey_mode: "off" | "optional" | "enforced";
  /** How many passkeys this administrator has registered. */
  passkey_count: number;
}

export const ADMIN_ME_KEY = ["admin-me"] as const;

/** GET /admin-auth/me. A 401 is the normal signed-out state, not an error. */
async function fetchAdminMe(): Promise<AdminMe | null> {
  const res = await fetch("/admin-auth/me", { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/admin-auth/me returned ${res.status}`);
  return res.json() as Promise<AdminMe>;
}

export function useAdminMe() {
  return useQuery({ queryKey: ADMIN_ME_KEY, queryFn: fetchAdminMe, retry: false });
}

/** Ask for a sign-in link. The server answers the same for everyone, so this never says who is an admin. */
export function useRequestAdminLink() {
  return useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch("/admin-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email }),
      });
      if (res.status === 429) throw new Error("Too many attempts. Try again in a while.");
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Something went wrong. Please try again.");
      }
    },
  });
}

export function useAdminLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch("/admin-auth/logout", { method: "POST", credentials: "include" });
    },
    onSuccess: () => {
      qc.removeQueries({ queryKey: ADMIN_ME_KEY });
      window.location.href = "/login";
    },
  });
}

/** The notice for ?error= on the sign-in page; null for anything we did not set. */
export function adminLoginNotice(error: string | null): string | null {
  if (error === "invalid_link") return "That sign-in link was invalid, already used, or has expired. Request a new one.";
  if (error === "passkey_required") return "This account signs in with a passkey. Use the passkey button below.";
  return null;
}

// ---------------------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------------------

export interface AdminPasskey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  device_type: string | null;
  backed_up: boolean;
}

export const PASSKEYS_KEY = ["admin-passkeys"] as const;

/** What the sign-in page may offer. Fails closed: no passkey button if the server cannot be asked. */
export function useAdminConfig() {
  return useQuery({
    queryKey: ["admin-config"],
    queryFn: async (): Promise<{ passkeys: boolean; passkey_mode: "off" | "optional" | "enforced" }> => {
      const res = await fetch("/admin-auth/config", { credentials: "include" });
      if (!res.ok) return { passkeys: false, passkey_mode: "off" };
      return res.json();
    },
    staleTime: 60_000,
  });
}

/** Does this browser and device do passkeys at all? */
export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Sign in with a passkey. Resolves when the server has started a session; reload to enter the console. */
export function useSignInWithPasskey() {
  return useMutation({
    mutationFn: async () => {
      try {
        const { challenge_id, options } = await postJson<{ challenge_id: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/admin-auth/passkey/options", {});
        const response = await startAuthentication({ optionsJSON: options });
        await postJson("/admin-auth/passkey/verify", { challenge_id, response });
      } catch (err) {
        throw new Error(passkeyErrorMessage(err, "sign-in"));
      }
    },
    onSuccess: () => {
      window.location.href = "/admin";
    },
  });
}

export function useAdminPasskeys() {
  return useQuery({
    queryKey: PASSKEYS_KEY,
    queryFn: async (): Promise<AdminPasskey[]> => {
      const res = await fetch("/admin-auth/passkeys", { credentials: "include" });
      if (!res.ok) throw new Error(`Could not load passkeys (${res.status})`);
      return ((await res.json()) as { passkeys: AdminPasskey[] }).passkeys;
    },
  });
}

/** Add a passkey on this device. */
export function useAddPasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      try {
        const { challenge_id, options } = await postJson<{ challenge_id: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("/admin-auth/passkeys/register/options", {});
        const response = await startRegistration({ optionsJSON: options });
        await postJson("/admin-auth/passkeys/register/verify", { challenge_id, response, name });
      } catch (err) {
        throw new Error(passkeyErrorMessage(err, "register"));
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PASSKEYS_KEY });
      void qc.invalidateQueries({ queryKey: ADMIN_ME_KEY });
    },
  });
}

export function useRemovePasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/admin-auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Could not remove the passkey (${res.status})`);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PASSKEYS_KEY });
      void qc.invalidateQueries({ queryKey: ADMIN_ME_KEY });
    },
  });
}
