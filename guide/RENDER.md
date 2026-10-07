# Deploying Mailforge on Render

One web service (the Docker image in this repo) plus one Postgres database. The web service runs the
API, the dashboard, the scheduler and the email queue together, so keep it to **one always-on instance**.

`render.yaml` in the repo root describes both. It has not been run against Render yet: if Render
rejects a field when you create the Blueprint, fix it from its message (plan names change).

## 0. Before you start

- **Push the code to GitHub.** Render builds from your repo. Commit everything, then push; check that
  `.env` is not in the commit (it is git-ignored) and that `render.yaml` is.
- Have these ready: your domain, a Resend API key and a verified sending domain, your Paystack keys,
  and (if you want Mailforge AI) a provider key. You enter secrets in Render's dashboard, never in the repo.

## 1. Create the services

1. Render dashboard, **New > Blueprint**, connect GitHub, pick the repo, branch `main`.
2. Render reads `render.yaml` and shows the web service `mailforge` and the database `mailforge-db`.
3. Fill in the variables it asks for (the ones marked `sync: false`):

| Variable | Value |
|---|---|
| `BASE_URL`, `DASHBOARD_URL`, `MAILFORGE_SITE_URL` | your public address with no trailing slash, e.g. `https://app.example.com` (use the `https://<name>.onrender.com` address first if your domain is not connected yet) |
| `MAILFORGE_SUPPORT_EMAIL`, `MAILFORGE_LEGAL_NAME` | shown on the public pages and in email footers |
| `MAILFORGE_PLATFORM_ADMINS` | the email(s) that get the Admin console |
| `PLATFORM_FROM_EMAIL`, `PLATFORM_RESEND_API_KEY` | sender for sign-in links and system emails, on a domain verified in Resend |
| `PAYSTACK_SECRET_KEY` | `sk_test_...` first |
| `PAYSTACK_USD_RATE` | cedis per US dollar (see `BILLING.md`); billing stays off for GHS without it |

   `ENCRYPTION_KEY` and `UNSUBSCRIBE_SIGNING_KEY` are generated for you. **Copy both from the service's
   Environment page into your password manager now and never change them.**
4. Click **Apply**. The first build takes several minutes (it compiles the whole project).

## 2. What happens on first start

- The database is empty. With `MAILFORGE_MIGRATE_ON_BOOT=true` the service creates the schema
  (and the `vector` extension) itself. The log shows `[migrate] community schema up to date`.
- Render checks `/health` and marks the service live.
- Your local demo data is **not** copied. You start with an empty database.
- The log prints a "CLAIM YOUR ACCOUNT" link for a default workspace. You can ignore it: customers and you sign
  up through `/signup`. (Anyone who can read your Render logs could use that link, so keep log access to yourself.)
- If `BASE_URL` or `DASHBOARD_URL` still point at localhost the log warns about it and sending is blocked until
  they are your real https address. That is deliberate.
- Verified locally: the production image builds from a clean checkout and, started against an empty database
  with Render's style of `PORT`, applies all 34 migrations (including `vector`) and serves the site.

## 3. Your domain

1. Service > **Settings > Custom Domains > Add**, enter your domain, and create the DNS record Render shows
   (a CNAME for a subdomain, or the record it lists for the root domain). The certificate is automatic.
2. Make sure `BASE_URL`, `DASHBOARD_URL` and `MAILFORGE_SITE_URL` use that domain, then redeploy.
   They are baked into sign-in links and unsubscribe links in email, so settle them before you send mail.

## 4. Connect the outside services

| Where | Set to |
|---|---|
| Paystack > Settings > API Keys & Webhooks, Webhook URL | `https://<your domain>/webhooks/paystack` |
| Resend > Webhooks (only if you use managed sending) | `https://<your domain>/webhooks/resend-platform` |
| Resend > Domains | your sending domain verified (SPF, DKIM) |

## 5. First sign-in as an admin

The Admin console on Render is the built-in one at `https://<your domain>/admin`. (The separate admin
port from local development, `MAILFORGE_ADMIN_PORT`, does not work on Render: a web service exposes one port.)

1. Open `https://<your domain>/signup` and create a workspace with the **same email** you put in
   `MAILFORGE_PLATFORM_ADMINS`. A sign-in link is emailed to you.
2. Sign in, then open `/admin`. Under **AI providers** add your provider key (the key is stored encrypted
   with `ENCRYPTION_KEY`).
3. Walk through `GO-LIVE.md`, section 5, with real small payments in Paystack test mode before going live.

## 6. Settings that matter on Render

- **Instance type:** Starter or larger. The Free type sleeps after inactivity, which stops the scheduler
  and email queue, so flows would not send.
- **One instance only.** Do not scale the service out (rate limiters and the scheduler are per instance).
- **`MAILFORGE_TRUST_PROXY=true`** is already in `render.yaml`. Without it the per-IP signup limit would
  count every visitor as one person.
- **Database:** use Render's private (internal) connection string, which `render.yaml` wires up. It is a
  direct connection, which Mailforge needs (it refuses pooled endpoints).
- **Backups:** turn on Render's Postgres backups and test one restore before you have customers.
- **Going live with money:** replace `sk_test_` with `sk_live_`, switch the Paystack Live Webhook URL, and
  set `PAYSTACK_USD_RATE` to a rate you have checked.

## 7. Updating

Push to `main` and Render rebuilds and redeploys; migrations run on start. Roll back from the service's
**Events** tab if a deploy misbehaves (database changes are not rolled back automatically).

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Build fails | read the build log; the project needs Node 22 (the Dockerfile sets it) |
| Service restarts at once | `DATABASE_URL` missing, or a pooled URL (`-pooler`); use the internal URL |
| No sign-in email arrives | `PLATFORM_FROM_EMAIL`/`PLATFORM_RESEND_API_KEY` unset or the domain not verified in Resend |
| "billing is OFF" in the log | `PAYSTACK_CURRENCY` is not USD and `PAYSTACK_USD_RATE` is missing |
| Paystack webhook shows 401 | the key in Render is not the same account/mode as the one sending the webhook |
| Everyone gets "too many attempts" on signup | `MAILFORGE_TRUST_PROXY` is not set |
