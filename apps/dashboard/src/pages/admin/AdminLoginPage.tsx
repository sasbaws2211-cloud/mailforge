/**
 * Sign-in page of the standalone admin console. One field: an email address.
 * Whatever is typed, the answer is the same ("if that address belongs to an
 * administrator, a link has been sent"), so the page cannot be used to find out
 * who runs the service.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BrandLockup } from "../../components/brand-lockup.js";
import { ThemeToggle } from "../../components/theme-toggle.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { adminLoginNotice, passkeysSupported, useAdminConfig, useRequestAdminLink, useSignInWithPasskey } from "../../admin-auth.js";
import { KeyRound } from "lucide-react";

export default function AdminLoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [params] = useSearchParams();
  const request = useRequestAdminLink();
  const config = useAdminConfig();
  const passkey = useSignInWithPasskey();
  const canUsePasskey = config.data?.passkeys === true && passkeysSupported();
  const enforced = config.data?.passkey_mode === "enforced";
  const notice = adminLoginNotice(params.get("error"));

  const [expired] = useState(() => {
    try {
      const flag = sessionStorage.getItem("mailforge-session-expired");
      if (flag) sessionStorage.removeItem("mailforge-session-expired");
      return flag === "1";
    } catch {
      return false;
    }
  });

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-6">
      <ThemeToggle className="absolute right-6 top-6" />
      <div className="w-full max-w-[380px]">
        <div className="mb-10 flex items-center gap-3">
          <BrandLockup markSize={24} />
          <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-text">Admin</span>
        </div>

        {sent ? (
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.015em] text-foreground">Check your inbox</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
              If <strong className="font-medium text-foreground">{email.trim()}</strong> belongs to an administrator, a sign-in link is on its way. It works once and expires in 15 minutes.
              {enforced && " Administrators who have a passkey sign in with it instead and get no link."}
            </p>
            <p className="mt-6 text-[15px] text-muted-foreground">
              Nothing arrived?{" "}
              <button
                type="button"
                className="cursor-pointer border-none bg-transparent p-0 text-[15px] text-accent-text underline underline-offset-4"
                onClick={() => {
                  setSent(false);
                  request.reset();
                }}
              >
                Try again
              </button>
              .
            </p>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              request.mutate(email.trim(), { onSuccess: () => setSent(true) });
            }}
          >
            <h1 className="text-xl font-semibold tracking-[-0.015em] text-foreground">Admin console</h1>
            <p className="mt-2 text-[15px] text-muted-foreground">For the people who run this service.</p>

            {canUsePasskey && (
              <div className="mt-6">
                <Button type="button" className="w-full" disabled={passkey.isPending} onClick={() => passkey.mutate()}>
                  <KeyRound aria-hidden="true" /> {passkey.isPending ? "Waiting for your device..." : "Sign in with a passkey"}
                </Button>
                {passkey.isError && (
                  <p className="mt-3 text-[14px] text-danger" role="alert">
                    {passkey.error instanceof Error ? passkey.error.message : "Passkey sign-in did not work."}
                  </p>
                )}
                <div className="my-6 flex items-center gap-3 text-[13px] text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  {enforced ? "no passkey yet?" : "or"}
                  <span className="h-px flex-1 bg-border" />
                </div>
              </div>
            )}
            <p className="text-[15px] text-muted-foreground">
              {enforced ? "If you have not registered a passkey yet, enter your email to receive a sign-in link and add one." : "Enter your email to receive a sign-in link."}
            </p>

            {expired && !notice && (
              <p className="mt-6 rounded-md border border-border bg-secondary px-3.5 py-2.5 text-[15px] text-foreground" role="status">
                Your session has ended. Sign in again to continue.
              </p>
            )}
            {(notice || request.isError) && (
              <p className="mt-6 rounded-md border border-warning bg-warning-soft px-3.5 py-2.5 text-[15px] text-foreground" role="alert">
                {notice ?? (request.error instanceof Error ? request.error.message : "Something went wrong. Please try again.")}
              </p>
            )}

            <label className="mt-6 block">
              <span className="text-[14px] text-foreground">Email</span>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
                required
                className="mt-1"
              />
            </label>
            <Button type="submit" className="mt-4 w-full" disabled={request.isPending || email.trim() === ""}>
              {request.isPending ? "Sending..." : "Send sign-in link"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
