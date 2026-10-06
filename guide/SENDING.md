# Managed sending (Mailforge sends your customers' email)

By default every workspace has to bring its own email provider (a Resend account or an SMTP
server). That is fine for developers and a wall for everyone else. **Managed sending** removes
the wall: when you give Mailforge a Resend account of your own, a workspace can simply turn on
"Mailforge Sending" and its email goes out through your account.

This guide is for the person running the service. Customers see a single switch in
*Settings > Email sending*.

## 1. How it works

A workspace's email goes out through, in this order:

1. **A provider it connected itself** (its own Resend key or SMTP server). Always wins.
2. **Managed sending**, if you offer it and the workspace turned it on.
3. Otherwise nothing: its messages wait, untouched, until a transport exists.

Under managed sending the sender is one of two things:

| | Sent from | When | Limit |
|---|---|---|---|
| **Shared address** | your `MAILFORGE_MANAGED_SHARED_FROM`, with the workspace's name as the sender name and its own address as Reply-To | straight away, until a domain is verified | `MAILFORGE_MANAGED_SHARED_DAILY_LIMIT` a day per workspace (default 100) |
| **Their own domain** | `hello@mail.theircompany.com` | once the workspace added the DNS records and Resend verified them | only the plan's monthly email limit |

The shared address is one sender reputation shared by everyone using it, which is why it is capped
and meant as a stepping stone. A workspace on its own verified domain carries its own reputation.

A workspace can never choose to send as someone else: the From address, name and Reply-To are fixed
by the platform when the message is sent, whatever the workspace's settings or message say.

## 2. Setting it up

1. **Create a Resend account for customer email.** Keep it separate from the one that sends your own
   login emails (`PLATFORM_RESEND_API_KEY`), so a customer problem can never stop people logging in.
2. **Create an API key with full access** (domains are created through the API) and set:

   ```
   MAILFORGE_MANAGED_RESEND_API_KEY=re_...
   ```

   Nothing is offered to customers until this is set. `MAILFORGE_MANAGED_SENDING=false` switches it
   off again without removing the key.
3. **(Recommended) a shared sending address.** Verify a domain you own in Resend (for example
   `mail.yourdomain.com`) and set:

   ```
   MAILFORGE_MANAGED_SHARED_FROM=notifications@mail.yourdomain.com
   MAILFORGE_MANAGED_SHARED_DAILY_LIMIT=100
   ```

   Without it, a workspace must verify its own domain before anything can be sent.
4. **Point a Resend webhook at your app** so bounces and spam complaints reach Mailforge:
   in Resend, add a webhook to `https://YOUR-APP/webhooks/resend-platform`, select the email events
   (delivered, bounced, complained, opened, clicked), and put its signing secret in:

   ```
   MAILFORGE_MANAGED_RESEND_WEBHOOK_SECRET=whsec_...
   ```

   This is not optional in practice: without it complaints and bounces are never recorded, nobody is
   suppressed, and the safety checks in section 4 have nothing to look at.
5. Restart. Set `MAILFORGE_PLATFORM_ADMINS` and the `PLATFORM_*` email settings too (see
   `guide/ADMIN.md`): the safety checks email you and your customers.

One webhook and one signing secret cover every workspace. Unlike a workspace's own provider, the
workspace is found from the message the event is about, and only workspaces on managed sending
count, so this endpoint can never touch a workspace that uses its own provider.

## 3. What customers do

*Settings > Email sending > Mailforge Sending > Turn on.* They can send at once from the shared
address. To use their own domain they enter it (a subdomain such as `mail.theircompany.com` is
safest), copy the three DNS records shown into their DNS provider, and press *Check now*. The page
also re-checks by itself while the domain is verifying, and starts sending from the domain the moment
Resend says it is verified. If a verified domain later stops verifying (the records were removed),
that workspace quietly goes back to the shared address.

What is checked when a domain is entered: it must be a real domain name; free email services
(gmail.com and so on) are refused; your own domains and anything under them are refused; and a domain
can belong to only one workspace (a domain exists once in your Resend account). A workspace may
change its domain a few times an hour. Changing or removing a domain removes the old one from Resend.

The test email in *Settings* works through managed sending too.

## 4. Protecting your Resend account

Everyone on managed sending shares your account's reputation, and providers judge an account by its
worst traffic. A workspace mailing a stale list or people who did not ask can get **your** account
throttled or suspended. So every 5 minutes Mailforge looks at each workspace's last 7 days:

| | Warn the owner | Pause the workspace |
|---|---|---|
| Spam complaints | 0.15% of sent mail | 0.3% and at least 2 complaints |
| Permanent bounces (address does not exist) | 2.5% | 5% and at least 5 bounces |

Nothing is judged until a workspace has sent 100 emails in the window, and temporary bounces
(full mailbox, server busy) never count.

- **Warn:** the owner is emailed once, then at most every 3 days while it lasts. Nothing stops.
- **Pause:** managed sending stops for that workspace at once. Its messages **wait, untouched**, and
  go out when sending resumes. The owner is told why, in plain words, without any account details,
  and **you** are emailed with a link to the workspace. It is recorded in the audit log as
  `managed_sending_auto_pause`. A pause happens even if email is not configured: protecting the
  account matters more than the notice.
- **Resume:** only a platform admin can, from the workspace's page in the admin console (*Resume
  managed sending*, with a reason; the owner is told). Do it once the list has been cleaned up. You
  can also pause a workspace by hand (*Pause managed sending*), for example while you investigate.

Adjusting the thresholds means changing the constants in `packages/core/src/managed-sending.ts`.

## 5. Good to know

- **A pause is not a verdict.** Look at the workspace first: a launch to an old list is the usual
  cause. Ask what changed before resuming.
- **Resend's own limits apply to you.** Resend limits how many domains one account can hold, and how
  fast you may create them, depending on your Resend plan: every customer domain counts. If creating a
  domain fails because of a limit, the customer sees "could not set up that domain right now" and the
  details are in your server log. Check your plan before opening signups widely.
- **Problems with your account never lose a customer's email.** If your key is wrong or Resend refuses
  at account level (not a problem with the message itself), the customer's messages are retried, not
  failed. Fix the account and they go out. A problem with one message (for example an invalid address)
  fails just that message.
- **Erasing a workspace** removes its sending domain from Resend (queued and retried if Resend is
  unreachable at the time), so the name is free again. Its sending setup is included in its data export.
- **Cost.** The email volume is billed to your Resend account. Each plan's monthly email limit bounds
  what one workspace can send; the shared address has its own small daily cap.
- **Single process.** The per-workspace limits on domain changes and checks are held in memory, like the
  other rate limits, so with several instances each counts for itself.

## 6. Settings reference

| Variable | Meaning |
|---|---|
| `MAILFORGE_MANAGED_RESEND_API_KEY` | Your Resend key for customer email. Managed sending is offered only when this is set. |
| `MAILFORGE_MANAGED_RESEND_WEBHOOK_SECRET` | Signing secret of the Resend webhook to `/webhooks/resend-platform`. |
| `MAILFORGE_MANAGED_SHARED_FROM` | Verified address used until a workspace verifies its own domain. Optional. |
| `MAILFORGE_MANAGED_SHARED_DAILY_LIMIT` | Emails per workspace per day on the shared address. Default 100. |
| `MAILFORGE_MANAGED_SENDING` | `false` switches managed sending off while keeping the key. |
| `MAILFORGE_MANAGED_RESEND_BASE_URL` | Resend API address. Only for testing against a fake; leave unset. |
