# Go-live checklist (hosted Mailforge)

Work top to bottom. Nothing here needs code changes except where marked. Items marked **[you]** need your own accounts, keys or decisions.

Why this exists: everything below was built and tested against local fakes (fake Resend, stub LLM, Mailpit); the Paystack payment flow has no automated test, so it has only been checked against Paystack's documentation. Section 5 is the first time real services are touched, so expect to fix small things there.

---

## 1. Decide and buy

- [ ] **[you]** Product domain, e.g. `mailforge.app` (app + landing) and `admin.<domain>` (admin console).
- [ ] **[you]** Sending domain for platform mail and the shared sender, e.g. `mail.<domain>`.
- [ ] **[you]** Host. It must run Docker and keep ONE app container (see 3). Any VPS or container host works.
- [ ] **[you]** Managed Postgres 16 with pgvector, direct connection (no pooler). Neon/RDS/Cloud SQL all work. Turn on automated daily backups and point-in-time recovery.
- [ ] **[you]** Accounts: Paystack (live), Resend, one LLM provider, and an error-tracking service if you want one (Mailforge has no Sentry hook built in).
- [ ] **[you]** Legal entity name for `MAILFORGE_LEGAL_NAME`, a real support mailbox, a real postal address (email footers require one).

## 2. Code cleanup (no credentials needed)

- [x] API key prefixes renamed `cl_live_`/`cl_pub_` to `mf_live_`/`mf_pub_`. Auth is by hash, so keys already issued keep working.
- [ ] **[you]** Replace the placeholder GitHub org `mailforgehq/mailforge` in `README.md` and `.github/workflows/close-prs.yml`, or delete those references if the repo stays private.
- [ ] **[you]** Terms (`/terms`) and Privacy (`/privacy`) are templates. Have a lawyer review them before launch.
- [ ] **[you]** Re-check the competitor prices behind the plan pricing in `packages/core/src/plans.ts` before publishing.
- [ ] Remove `.pnpm-store/` from the project root and make sure it is in `.gitignore`.
- [ ] The git remote still points at `claroshq/claros`. Point it at your own repo before pushing anything.

## 3. Deploy

- [ ] Create the production `.env` from `.env.example` on the server. Never reuse the local `.env`.
- [ ] Generate fresh secrets: `ENCRYPTION_KEY`, `UNSUBSCRIBE_SIGNING_KEY`. **Back both up in a secrets manager.** Losing `ENCRYPTION_KEY` loses every stored transport and LLM credential. Losing `UNSUBSCRIBE_SIGNING_KEY` breaks every unsubscribe link already delivered.
- [ ] `DATABASE_URL` = the managed Postgres direct URL. Run migrations (`MAILFORGE_MIGRATE_ON_BOOT=true` on first boot, or the install command).
- [ ] Use the production compose only: `docker compose up -d`. Do NOT include the Mailpit or local-admin override files. Remove the `postgres` service if using managed Postgres.
- [ ] Put HTTPS in front (Caddy or nginx, or the host's load balancer) for the app and admin hostnames.
- [ ] **Exactly one app container.** Rate limiters are in memory and the scheduler has no multi-instance lock. If you ever scale out, follow `DEPLOYMENT.md` (one `--role=scheduler`, shared limiter store needed first).
- [ ] Set `NODE_ENV=production`.
- [ ] Set up uptime monitoring on `/` and on `/health`, plus log retention.
- [ ] **Test a restore** from a Postgres backup once, before you have customers.

## 4. Environment variables (production values)

Core:
```
NODE_ENV=production
DATABASE_URL=...                 # managed Postgres, direct
ENCRYPTION_KEY=...               # generate, back up
UNSUBSCRIBE_SIGNING_KEY=...      # generate, back up
BASE_URL=https://app.<domain>
DASHBOARD_URL=https://app.<domain>
PORT=3000
```

Hosted-SaaS switches:
```
MAILFORGE_PUBLIC_SITE=true       # landing, pricing, signup
MAILFORGE_ENFORCE_PLANS=true     # plan limits, onboarding, AI allowances
MAILFORGE_SITE_URL=https://<domain>
MAILFORGE_SUPPORT_EMAIL=support@<domain>
MAILFORGE_LEGAL_NAME=Your Company Ltd
MAILFORGE_DELETION_GRACE_DAYS=7
```

Platform mail (login links, welcome, nudges, alerts). Pick Resend or SMTP:
```
PLATFORM_FROM_EMAIL=no-reply@mail.<domain>
PLATFORM_FROM_NAME=Mailforge
PLATFORM_RESEND_API_KEY=re_...   # or PLATFORM_SMTP_HOST/PORT/SECURE/USER/PASSWORD
```
Without this nobody can sign in. Verify the sending domain in Resend first (SPF, DKIM, DMARC).

Billing (Paystack live):
```
PAYSTACK_SECRET_KEY=sk_live_...   # LIVE key; Paystack signs webhooks with it, so there is no separate hash
PAYSTACK_CURRENCY=USD             # must be a currency your Paystack account can charge
# For Ghana cedis instead: PAYSTACK_CURRENCY=GHS and PAYSTACK_USD_RATE=<cedis per $1>.
# Billing stays OFF for a non-USD currency until a valid rate is set.
```
In Paystack (Settings, API Keys & Webhooks): Live Webhook URL `https://app.<domain>/webhooks/paystack`. Leave `PAYSTACK_BASE_URL` unset (it is only for the fake). Check first that USD is enabled for your business; see "Currency" in `BILLING.md`.

Managed sending (customers without their own SMTP):
```
MAILFORGE_MANAGED_RESEND_API_KEY=re_...         # separate key from PLATFORM_RESEND_API_KEY
MAILFORGE_MANAGED_RESEND_WEBHOOK_SECRET=whsec_...
MAILFORGE_MANAGED_SHARED_FROM=notifications@mail.<domain>   # verified in Resend
MAILFORGE_MANAGED_SHARED_DAILY_LIMIT=100
```
In Resend create ONE webhook: `https://app.<domain>/webhooks/resend-platform`, events: delivered, bounced, complained. It is not auto-registered. Check your Resend plan's domain-count limit, because each customer's own domain uses one.

SMTP safety (leave defaults, they are ON when hosted):
```
# MAILFORGE_RESTRICT_SMTP_HOSTS=true
```
Do NOT set `MAILFORGE_SMTP_ALLOWED_HOSTS=mailpit` in production.

Admin console:
```
MAILFORGE_PLATFORM_ADMINS=you@<domain>
MAILFORGE_ADMIN_PORT=3011
MAILFORGE_ADMIN_URL=https://admin.<domain>
MAILFORGE_ADMIN_PASSKEYS=optional     # switch to enforced once you registered a passkey
MAILFORGE_ADMIN_RP_ID=                # default = host of ADMIN_URL; changing it invalidates passkeys
```
Decide the admin hostname BEFORE registering a passkey. Expose the admin port only on `admin.<domain>` (consider an IP allow-list too).

AI: configure in the admin console (AI providers tab), not env. Add prices so cost and the monthly budget mean something, and set a monthly dollar budget.


## 5. Real-service test pass (do this before inviting anyone)

Use small real amounts and your own addresses. Tick each only when you saw it work.

**Platform mail**
- [ ] Sign up with a real inbox. The login link arrives within a minute and is not in spam.
- [ ] Check the headers of that email: SPF, DKIM and DMARC all pass.

**Paystack** (the payment flow has never run against real Paystack, so watch these closely)
- [ ] Plan creation works in your currency (if USD is not enabled for the account it fails here: see `BILLING.md`, Currency).
- [ ] Upgrade to Starter monthly with a real card. Plan flips to Starter, receipt arrives.
- [ ] The webhooks arrive and are accepted: look in `billing_events` for `charge.completed` and `subscription.create`, and in the Paystack dashboard that deliveries show 200. A 401 means the secret key and the webhook disagree.
- [ ] `subscriptions.provider_subscription_id` is filled in (it comes from `subscription.create`). If it is empty after a minute, check the payload shape.
- [ ] Close the payment page without paying: you land back on the Plan page with a "cancelled" notice.
- [ ] Wait for or force a renewal (Paystack test mode can bill sooner on a short plan). Confirm it is matched to the right workspace (matching is by email, plan code and amount).
- [ ] Cancel from the Plan page: the subscription shows as disabled in Paystack, and no further charge happens.
- [ ] Cancel from a Paystack email link or the Paystack dashboard: the plan page shows "cancelling" after the `subscription.disable` webhook.
- [ ] Annual plan: confirm the charged amount is `priceAnnualUsd` (190/490/1290) and the interval is annually.
- [ ] Mobile-money customers: confirm what happens (subscriptions are cards only).

**Resend managed sending**
- [ ] New workspace turns on "Mailforge Sending" and a test email goes out from the shared sender.
- [ ] Add a real customer-style domain, publish the DNS records, and see the page turn green on its own.
- [ ] Send to a bounce address (Resend test address) and confirm the webhook suppresses it. Confirm the real bounce payload matches what the handler expects.
- [ ] Add the same domain twice or a taken domain and read the real error text (the "already exists" detection is a guess).
- [ ] Delete a test workspace and confirm the Resend domain is removed.

**AI**
- [ ] Enter the real provider key in Admin console, press Test, then generate a flow draft from a customer workspace.
- [ ] Confirm token usage and dollar cost appear. If you use Anthropic, give an OpenAI-style provider the `embedding_model` or knowledge-base search is unavailable.

**Product flow**
- [ ] Signup, first sign-in, welcome email, onboarding panel, sample event, Welcome flow email lands in a real inbox.
- [ ] Unsubscribe link in that email works from the real inbox.
- [ ] Hit a plan limit on purpose (a Free workspace past 500 contacts) and see the 402 and the banner.
- [ ] Export data, schedule deletion, cancel deletion.
- [ ] Admin console: sign in, register a passkey on a REAL device, sign out, sign in with it. Then flip to `enforced`.
- [ ] Suspended paying customers are still charged by Paystack. Know the manual step: cancel the subscription in the admin console first.

## 6. Soft launch

- [ ] Invite 3 to 5 design partners, free, and watch the admin funnel (Overview) and the container logs daily for a week.
- [ ] Check Resend reputation and bounce rate after the first real sends.
- [ ] Only then open public signup and announce.

## 7. Known gaps accepted for launch

- In-memory rate limiters (single instance only).
- No recovery codes for admin passkeys (recovery = `tools/reset-admin-passkeys.mjs` on the server).
- Resend webhook is created by hand.
- No email on grace-period erasure completion.
- Dark-mode link colours only help clients that honour `prefers-color-scheme` (not the Gmail apps).
- Test suite has a few known parallel-run flakes (global-count tests); they pass alone.
