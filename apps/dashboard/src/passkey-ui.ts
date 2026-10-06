/**
 * Plain-language rules for the passkey screens: what to say when the browser or
 * device says no, and a sensible default name for a new passkey. No browser code
 * in here, so it is easy to test.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */

/**
 * Turn whatever went wrong into one sentence a person can act on. The browser reports a
 * cancelled prompt and a timed-out one the same way (NotAllowedError), so those are
 * worded together; the library adds its own `code` for a few cases.
 */
export function passkeyErrorMessage(err: unknown, action: "sign-in" | "register"): string {
  const e = err as { name?: string; code?: string; message?: string } | null;
  const name = e?.name ?? "";
  const code = e?.code ?? "";
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") {
    return "This device already has a passkey for the admin console.";
  }
  if (code === "ERROR_CEREMONY_ABORTED" || name === "NotAllowedError" || name === "AbortError") {
    return action === "sign-in" ? "Sign-in was cancelled or timed out. Try again." : "Adding the passkey was cancelled or timed out. Try again.";
  }
  if (name === "SecurityError" || code === "ERROR_INVALID_RP_ID" || code === "ERROR_INVALID_DOMAIN") {
    return "This page is not at an address passkeys can be used on. Passkeys need https (or localhost).";
  }
  if (name === "NotSupportedError") return "This browser or device does not support passkeys.";
  // A message from our own server (for example "That passkey could not be verified.") is safe to show.
  if (err instanceof Error && err.message && !/^[A-Za-z]*Error:/.test(err.message)) return err.message;
  return action === "sign-in" ? "Passkey sign-in did not work. Try again, or use an emailed link." : "The passkey could not be added. Try again.";
}

/** "Chrome on Windows", "Safari on iPhone"...: a starting name the person can change. */
export function suggestPasskeyName(userAgent: string): string {
  const ua = userAgent || "";
  const os = /iPhone/i.test(ua) ? "iPhone" : /iPad/i.test(ua) ? "iPad" : /Android/i.test(ua) ? "Android" : /Windows/i.test(ua) ? "Windows" : /Mac OS X|Macintosh/i.test(ua) ? "Mac" : /CrOS/i.test(ua) ? "ChromeOS" : /Linux/i.test(ua) ? "Linux" : "";
  // Order matters: Edge and Opera both say "Chrome", and Chrome says "Safari".
  const browser = /Edg\//i.test(ua) ? "Edge" : /OPR\//i.test(ua) ? "Opera" : /Firefox\//i.test(ua) ? "Firefox" : /Chrome\//i.test(ua) || /CriOS\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari" : "";
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "This device";
}

/** "Never used", "today", "yesterday", "5 days ago", else a date. */
export function lastUsedLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "Never used";
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "Used today";
  if (days === 1) return "Used yesterday";
  if (days < 60) return `Used ${days} days ago`;
  return `Used ${new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}`;
}

/** What the sign-in page says above its form for a ?error= value we set; null for anything else. */
export function passkeyRequiredNotice(error: string | null): string | null {
  return error === "passkey_required" ? "This account signs in with a passkey. Use the passkey button below." : null;
}
