# Platform admin console

The Admin console is for whoever runs the Mailforge service. It shows every customer
workspace and lets you fix plans, give trials, and switch a workspace off. Ordinary
customers never see it.

## 1. Turn it on

Set the email addresses of the people who run the service in `.env`:

```
MAILFORGE_PLATFORM_ADMINS=you@yourdomain.com,partner@yourdomain.com
```

Restart the app. Those people then see an **Admin** item at the bottom of the sidebar,
which opens the console at `/admin`.

The console is a page of its own, not part of the customer workspace: it has its own
header (with an **Admin** marker, Overview and Audit log tabs, a link back to your
workspace, theme and sign-out) and none of the workspace screens or banners. It also
works when your own workspace is suspended or waiting to be deleted, which the workspace
itself does not. Someone who is not an admin who opens `/admin` sees a plain not-found
page.

- It is an environment setting on purpose. There is no screen or API a customer could
  use to make themselves an admin.
- Sign-in is by emailed link, so **whoever controls that mailbox is an admin**. List only
  mailboxes you control.
- An admin is an ordinary user of an ordinary workspace as well. Sign in with the address
  that owns your own workspace.
- Everyone else gets a plain "not found" for `/admin` and `/v1/admin/*`.

## 2. What you can see

- **Overview**: workspaces, new this week and month, monthly recurring revenue,
  trials, emails sent this month, and a list of things that need attention (overdue
  payments, lapsed subscriptions, trials ending within 3 days).
- **Workspaces**: search by name, slug or any member's email; filter by trial, free,
  paid or suspended.
- **One workspace**: plan in force and plan on record, trial and payment dates, usage
  counts, team, subscription and payment events, and the history of admin changes.

The console shows counts and account facts only. It never shows message content, contact
details or API keys.

## 3. What you can do

Every change needs a written reason (up to 300 characters) and is recorded in the audit
log with your email, in the same step as the change.

| Action | What it does |
| --- | --- |
| Set plan by hand | Puts the workspace on Free, Starter, Growth or Scale with no expiry, replacing any trial. For design partners, goodwill, fixing a mistake. |
| Give a trial | Growth trial ending the chosen number of days from now (1 to 90). Revives an ended trial. |
| Cancel subscription | Stops future charges. The plan runs to the end of the paid period. Needs billing configured. Nothing is refunded here: do refunds in Paystack. |
| Suspend / Reinstate | Suspend switches the workspace off. Reinstate switches it back on. |

Rules the server enforces:

- A workspace with a **live paid subscription** cannot be moved by hand or given a trial,
  because its next charge would overwrite your change. Cancel the subscription first.
- You cannot suspend your own workspace.
- A suspended workspace can still be reinstated, and admins keep access to the console
  even if their own workspace is suspended.

## 4. What suspension does

- Nobody in the workspace can use the dashboard. They see a "workspace suspended" page
  and can only sign out.
- The ingest API (`/v1/track`, `/v1/identify`, `/v1/batch`) refuses the workspace's keys
  with `403 workspace_suspended`.
- Nothing is sent. Approved emails stay queued and go out when you reinstate.
- Nothing is deleted. Data, flows, contacts and subscriptions are untouched.
- A paying customer who is suspended is **still charged** by Paystack. Cancel the
  subscription too if you do not want that.
- Unsubscribe links in emails already sent keep working: they are public pages.

## 5. Known limits

- No "sign in as customer" (impersonation) on purpose: it needs its own consent and
  logging design. Use the usage counts and ask the customer for screenshots.
- Revenue figure counts active USD subscriptions only (yearly counted as a twelfth).
  Plans granted by hand count as zero revenue.
- No workspace deletion or data export yet.
- Platform admins are an environment list; changing it needs a restart.

## 6. Running the console as its own deployment

By default the console is a page inside the customer app (`/admin`) and you sign in with
your workspace login. For production you will usually want it **separate**: its own
address, its own sign-in, and nothing about it reachable from the customer app.

### Turn it on

```
docker compose -f docker-compose.yml -f docker-compose.admin.yml up -d
```

or set these in `.env` and restart:

```
MAILFORGE_ADMIN_PORT=3011
MAILFORGE_ADMIN_URL=https://admin.yourdomain.com
MAILFORGE_PLATFORM_ADMINS=you@yourdomain.com
```

The console now listens on its own port (3011 locally: http://localhost:3011). The server
refuses to start if `MAILFORGE_ADMIN_PORT` is not a port or equals `PORT`.
`MAILFORGE_ADMIN_HOST` (default: the same as `HOST`) lets you bind it to `127.0.0.1` so only
your reverse proxy can reach it.

### What changes

- **The customer app serves no admin routes.** `/v1/admin/*` is gone from it (404), and it
  never tells its dashboard that a user is an administrator, so there is no Admin item.
- **Its own sign-in, for administrators only.** Enter an address on the console's login
  page; if it is on `MAILFORGE_PLATFORM_ADMINS` a link is emailed from the platform sender
  (`PLATFORM_*` settings, so these must be configured; locally Mailpit catches it). The
  answer is the same for any address, so the page cannot be used to find administrators.
  An administrator needs no workspace account.
- **The link** works once, lasts 15 minutes, is stored only as a hash, and opening it does
  nothing until you press the button (mail scanners that fetch links cannot sign anyone in).
- **The session** lasts 8 hours, lives in a database table, and is checked against the
  administrator list on every request: remove someone from `MAILFORGE_PLATFORM_ADMINS`,
  restart, and their next request signs them out. Signing out deletes the session.
- **Separate cookies.** The console uses `mailforge_admin_session` (HttpOnly, SameSite=Lax,
  and Secure when `MAILFORGE_ADMIN_URL` is https). A customer session does nothing on the
  console and a console session does nothing on the customer app.
- **Cross-site requests are refused:** any write whose `Origin` is not the console's own
  gets a 403. The page cannot be framed, is marked noindex, and API responses are never cached.
- Sign-in requests are limited to 5 an hour per address and 20 per client (in memory, per
  process).
- Actions are still audited. Because the administrator is not a workspace user, the entry
  records their email and no user id. You still cannot suspend or delete a workspace that
  you are a member of under the same email.

### Putting it behind a proxy (production)

Serve the console on its own hostname over https, forwarding to the admin port. Caddy:

```
admin.yourdomain.com {
    # Optional but recommended: only your office or VPN may even reach the page.
    @blocked not remote_ip 203.0.113.0/24
    respond @blocked 404
    reverse_proxy 127.0.0.1:3011
}
```

nginx: `proxy_pass http://127.0.0.1:3011;` with the usual `Host` and `X-Forwarded-*` headers,
inside a `server` block for `admin.yourdomain.com` with a TLS certificate (and `allow`/`deny`
lines for an IP allow-list).

Checklist: `MAILFORGE_ADMIN_URL` is the public https address; the platform email sender
works (try signing in); the admin port is not published to the internet directly; your own
mailbox is protected, because **whoever can read an administrator's email can sign in as
them**. For stronger protection put the console behind an IP allow-list, a VPN or an
identity-aware proxy as well.

### Passkeys

The separate console supports passkeys, so that a stolen mailbox is no longer enough to
get in. A passkey is a key pair made on the administrator's own device: the private half
never leaves it and is unlocked there (fingerprint, face, PIN or a hardware key), and the
server keeps only the public half. It works only on the console's real address, so a
look-alike site cannot use it. **No outside service, account, key or approval is
involved**: the browser and operating system do their part, and an open-source library
(`@simplewebauthn/server`) checks the result inside the server. Attestation is "none", so
no authenticator maker has to vouch for anything.

```
MAILFORGE_ADMIN_PASSKEYS=optional     # off | optional (default) | enforced
MAILFORGE_ADMIN_RP_ID=                # leave unset; see "The address matters" below
```

- **optional**: passkeys and emailed links both work. Signed in by email, the console shows
  a banner asking you to add a passkey (Security tab).
- **enforced**: an administrator who has a passkey must use it. For them no link is sent
  (the page gives the same answer as for anyone, so nothing is revealed) and a link issued
  earlier stops working. An administrator with **no** passkey yet can still use a link, to
  sign in and register one. The last passkey cannot be removed; add a second first.
- **off**: no passkey endpoints at all.
- Sign-in needs no email typed: press "Sign in with a passkey" and the device offers the
  passkeys it holds. Registering asks for a discoverable credential with user verification
  required (a bare tap is refused).
- Each administrator can register up to 10 (one per device or key). Register at least two:
  a lost phone is otherwise a lockout. Synced passkeys (iCloud Keychain, Google Password
  Manager, a password manager) work and show as "synced".
- A stored counter detects cloned credentials (a counter that does not move forward is
  refused). Many phones always report 0, which is accepted.

**The address matters.** A passkey is bound to the console's host name (taken from
`MAILFORGE_ADMIN_URL`; `localhost` in development, which browsers treat as secure). **If you
later move the console to a different host name, every registered passkey stops working**
and each administrator must register again. Choose the final address before rolling
passkeys out. `MAILFORGE_ADMIN_RP_ID` can bind them to a parent name instead (for example
`yourdomain.com`, which then also covers `admin.yourdomain.com`), but set it before anyone
registers and never change it. In production passkeys need https.

**Lost device.** A passkey cannot be reset by email (that would defeat it), so recovery is a
command run by whoever controls the server:

```
docker compose exec -T -e ADMIN_EMAIL=you@yourdomain.com app sh -c \
  "cd /app/packages/worker && node --input-type=module" < tools/reset-admin-passkeys.mjs
```

It removes that administrator's passkeys and sessions (`ADMIN_EMAIL=all` for everyone).
They can then sign in by emailed link and register a new passkey. In an emergency, set
`MAILFORGE_ADMIN_PASSKEYS=optional` and restart to allow links again.

### Known limits of the separate deployment

- A passkey is only a second line of defence when the mode is `enforced` and every
  administrator has registered one; in `optional` an emailed link still works. There are no
  authenticator-app codes or recovery codes.
- Rate limits are in memory, so each process counts for itself.
- It runs inside the same server process as the customer app, on a second port. Putting it
  in a separate container or machine would need the server to be started with only that
  role; that is not built.

## 7. AI providers (Mailforge AI)

Flow compiling, AI drafting, email generation and knowledge-base search all need an AI
provider. A workspace gets one of two ways:

| | Whose key | Counted against the plan? | Who pays the AI bill |
|---|---|---|---|
| **Mailforge AI** | yours, set once here | yes, per month | you |
| **Their own key** | the customer's, saved in Settings | never | the customer |

A workspace that has saved its own key always uses it, and only it: if that key breaks, the
customer is told so rather than silently moving onto your bill. A workspace with no key uses
Mailforge AI. Customers never see which vendor or model is behind it.

### Setting it up

Open **AI providers** in the console. Choose a provider, paste the key, give a reason, and
press *Verify and save*. The key is checked with a real one-token call first, so a wrong key
is refused and nothing is stored. It is stored encrypted (`ENCRYPTION_KEY` must be set), shown
nowhere afterwards, and never written to the audit log.

- **Primary** is used first for every workspace without a key of its own.
- **Fallback** (optional) is tried automatically when the primary fails: an outage, a rate
  limit, an unpaid bill, a revoked key. Pick a different vendor from the primary. A rejected
  request (HTTP 400) does not fail over, because a second provider would only repeat it.
- **Switch off** is the kill switch: the slot is skipped at once without deleting its key.
  With no slot switched on, workspaces without their own key cannot compile or draft.
- **Test key** makes one tiny real call with the saved key and reports what the provider said.
- **Knowledge-base search** needs an embedding model. Anthropic has none, so give the
  *Embedding model* to whichever provider has one (for example OpenAI's
  `text-embedding-3-small`); search uses the first provider that names one.

### Allowances (only when `MAILFORGE_ENFORCE_PLANS=true`)

Each plan includes a monthly (UTC calendar month) allowance of Mailforge AI tokens. The
numbers live in `packages/core/src/plans.ts` next to the other limits:

| Free | Starter | Growth | Scale |
|---|---|---|---|
| 20,000 | 300,000 | 1,500,000 | 8,000,000 |

At the cap nothing is deleted. AI drafting and compiling stop with a clear message
("upgrade your plan or add your own key"); emails already queued for AI generation simply wait
and carry on when the month rolls over, the plan is upgraded, or the customer adds a key.
Knowledge-base embeddings are counted but never blocked, because a refused one would mark an
entry as failed. Self-hosted installs (enforcement off) have no cap.

Adjust the numbers to your costs: a Free workspace that maxes out costs you its allowance in
tokens, so keep the Free figure small. The tokens are the provider's own count; if a provider
reports none, the call is estimated from text length so an allowance cannot be dodged.

### What you see

The page shows this month's Mailforge AI tokens, calls and failed calls, a split by feature, the
ten heaviest workspaces, and (separately, as "not your cost") tokens spent on customers' own
keys. A failed-call rate that climbs usually means a revoked key or a provider outage. Each
workspace's page has an **AI** card: which source it uses, its tokens against its allowance.

Every change here is in the audit log as `ai_provider_set`, `ai_provider_change`,
`ai_provider_enable`, `ai_provider_disable` or `ai_provider_remove`, with your reason.

### Cost, allowance overrides and the failure alert

**Cost in dollars.** When you add or change a provider, fill in its *Input price* and *Output
price* (dollars per million tokens, copied from the provider's price list). Every call on your
provider then records what it cost, so the page shows this month's cost in dollars in total, per
feature and per workspace. Leave the prices blank and cost shows as $0, and the page warns that
the figures undercount. Calls on a customer's own key are never priced (it is not your cost).
Knowledge-base embeddings are counted in tokens but not priced.

**Allowance per workspace.** On a workspace's page, *AI allowance* gives that workspace its own
monthly token allowance instead of the plan's: a number (more or less than the plan, even zero),
*No cap*, or back to the plan's. It is audited as `set_ai_allowance` and only matters where
plans are enforced. The customer's own usage meter follows it.

**Failure alert.** If at least half of the calls on your provider fail over the last 15 minutes
(and there were at least 10), the AI providers page shows a red banner and every address in
`MAILFORGE_PLATFORM_ADMINS` is emailed from the platform sender (`PLATFORM_*` settings must be
configured). One email per incident, a reminder an hour later while it lasts, nothing once it
recovers; the state survives restarts. Only your own provider counts: a customer's broken key never
alerts you. The check runs every 5 minutes inside the server. Tune it with
`MAILFORGE_AI_ALERT_MIN_CALLS`, `MAILFORGE_AI_ALERT_FAIL_RATE` (0 to 1),
`MAILFORGE_AI_ALERT_WINDOW_MINUTES` and `MAILFORGE_AI_ALERT_COOLDOWN_MINUTES`.

### Monthly dollar budget (a hard cap)

On the AI providers page, *Monthly budget* sets the most Mailforge AI may cost you in a calendar
month (UTC), measured from the prices you entered on your providers. It needs those prices to
mean anything: with none set, cost is $0 and the budget never trips.

- **At 80%** every platform admin is emailed a warning.
- **At 100%** Mailforge AI pauses for every workspace that has no AI key of its own, and a second
  email says so. Drafting and compiling answer with a clear "temporarily unavailable, add your own
  key or try again later" message (HTTP 503); emails already waiting for AI-written content stay
  queued and carry on by themselves once it resumes. The customer is never told a dollar figure.
- **Customers on their own key are never affected**, and neither are knowledge-base embeddings
  (they are not priced).
- **Raising or removing the budget resumes AI immediately.** It resets by itself on the 1st.
- **When it is back on, every platform admin is emailed** ("Mailforge AI is back on"): once per pause,
  saying why (budget raised to $X, budget removed, or a new month began) and that queued work is
  carrying on by itself. It goes out within 5 minutes of the change. If you raise the budget and put it
  back before the next check, nothing is sent, because AI never actually came back. A pause that began
  while email was not configured still gets its "back on" email once a sender exists.
- Each threshold alerts once per month per budget amount, so raising the budget re-arms the alerts
  for the new amount. If email is not configured (or a delivery fails) nothing is marked as sent and
  the next check, within 5 minutes, tries again. The page also shows a banner at 80% and 100%.
- Changes are audited as `ai_budget_set` / `ai_budget_clear` with your reason.

The budget is independent of plan enforcement and of per-workspace allowances: even a workspace given
*No cap* is paused while the budget is used up, because the budget protects your bill.
The check is a spend total computed when AI is used, so one call that starts just below the line can
finish a little over it; set the budget a little under the amount you can really afford.

## Signup funnel

The Overview page has a **Signup funnel** (last 7, 30 or 90 days) for workspaces created through public signup:
signed up, signed in, added an address, can send, turned on a flow, sent a first event, first email delivered, paying.

- Each bar is counted on its own from what is in the workspace, as a share of everyone who signed up in the window.
  A later step can therefore be higher than an earlier one (an event sent before an address was added).
- "Biggest drop" names the pair of neighbouring steps where the most workspaces were lost. Ties go to the earlier step.
- Below the bars: median time from signup to first delivered email, **stalled** (signed in, over a day old, no email
  yet, not set aside), **reminded** (got at least one stall reminder) and **set aside** (chose "I will finish this later").
- A line under the bars shows what the cohort asked for at signup (goal picker), most common first.
- Counts only. No names, addresses or message content. API: `GET /v1/admin/funnel?days=7|30|90`, platform admins only.
