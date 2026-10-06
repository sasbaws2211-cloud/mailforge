/**
 * Runs before every API test file.
 *
 * Removes environment settings that change runtime behavior but that tests do
 * not mean to depend on. A developer who runs the stack locally has these in
 * .env (the platform email sender points at a local Mailpit), and without this
 * the auth tests that expect "no transport: print the link to the console"
 * would silently send real mail instead.
 *
 * A test that needs one of these sets it itself and restores it afterwards.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PLATFORM_")) delete process.env[key];
}
delete process.env.MAILFORGE_PUBLIC_SITE;
delete process.env.MAILFORGE_ENFORCE_PLANS;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("FLUTTERWAVE_")) delete process.env[key];
}

// SMTP destination rules are read from the environment; tests that need them set them.
for (const k of ["MAILFORGE_RESTRICT_SMTP_HOSTS", "MAILFORGE_SMTP_ALLOWED_HOSTS", "MAILFORGE_SMTP_ALLOWED_PORTS"]) delete process.env[k];

// Managed sending is configured by the operator; tests that need it set these themselves.
for (const k of Object.keys(process.env)) if (k.startsWith("MAILFORGE_MANAGED_")) delete process.env[k];
