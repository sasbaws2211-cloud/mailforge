/**
 * Runs before every worker test file.
 *
 * Removes environment settings that change drain behavior but that tests do
 * not mean to depend on. A developer running the hosted stack locally has plan
 * enforcement switched on in .env; without this, every drain test would be
 * quietly subject to Free-plan limits and the "Sent with Mailforge" credit.
 *
 * A test that needs one of these sets it itself and restores it afterwards.
 */
delete process.env.MAILFORGE_ENFORCE_PLANS;
delete process.env.MAILFORGE_SITE_URL;
delete process.env.UNSUBSCRIBE_SIGNING_KEY; // tests that need it pass their own

// SMTP destination rules are read from the environment; tests that need them set them.
for (const k of ["MAILFORGE_RESTRICT_SMTP_HOSTS", "MAILFORGE_SMTP_ALLOWED_HOSTS", "MAILFORGE_SMTP_ALLOWED_PORTS"]) delete process.env[k];

// Managed sending is configured by the operator; tests that need it set these themselves.
for (const k of Object.keys(process.env)) if (k.startsWith("MAILFORGE_MANAGED_")) delete process.env[k];
