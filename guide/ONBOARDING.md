# Customer onboarding

How a new customer of the hosted product gets from signup to their first delivered email, what the
product does at each point, and how to see where people stall.

Onboarding only exists on a hosted install (`MAILFORGE_ENFORCE_PLANS=true`). A self-hosted install
keeps its own setup screen, which asks about environment variables and key files.

## The journey

| # | Moment | What the customer sees | What makes it done |
|---|--------|------------------------|--------------------|
| 1 | `/signup` | Workspace name + work email. 14-day Growth trial, no card | Workspace created |
| 2 | Signup email | "Your login link" (platform sender) | Link clicked, **Sign in** pressed |
| 3 | First sign-in | **Welcome email** (once) with the three first steps; Home opens on the onboarding panel | n/a |
| 4 | Add business address | Settings > Postal address | An address is saved |
| 5 | Choose how email is sent | Settings > Email sending | An active own transport, **or** Mailforge Sending switched on |
| 6 | Turn on first flow | Welcome flow card on Home: install, review, activate | At least one flow is active |
| 7 | Send first event | Integrate: create a key, **Send test event** (a real `signed_up`) | At least one event received |
| 8 | First email delivered | Home shows **You are live** card for 3 days | At least one email has status `sent` |

Steps 4 to 8 are worked out from what is in the workspace, never from clicks, so progress is the same
on every browser and cannot drift. Order is a suggestion: a later step can finish first and the panel
still points at the first one left.

## Behaviour worth knowing

- **Later, not never.** "I will finish this later" stores `dismissed_at` on the workspace. The panel
  becomes a slim "Finish setup" banner; the banner button brings the panel back.
- **Finished.** When every step is done the panel steps aside, `completed_at` is stored once, and the
  "You are live" card shows for 3 days (closable; remembered in that browser).
- **The first email is fast.** An event starts the flow within seconds (trigger-check, advance,
  process, drain). It does not wait for the 15-minute cron, so the test event in step 7 normally
  produces the step 8 email in under 10 seconds.
- **Welcome email rules.** Sent through the platform sender (`PLATFORM_*`), only to workspaces that came
  through signup, only once (claimed with one UPDATE, so two quick sign-ins cannot both send). If delivery
  fails the claim is released and the next sign-in retries. No platform sender configured: nothing sent,
  nothing claimed. It never delays or fails sign-in.

## Goal-specific welcome email

The welcome email reflects the goal chosen at signup (`settings.signup.goal`). Same three first steps, subject
and button for everyone; what changes is one line after the greeting and, for two goals, a paragraph after the steps:

| Goal | Added to the welcome email |
|------|----------------------------|
| Welcome new signups | "You said you want to welcome new signups" and a note that the Welcome flow is exactly that |
| Turn trial users into paying customers | "You said..." plus "After that": the Time-Limited Trial flows, named, as drafts |
| Move free users to a paid plan | "You said..." plus "After that": the Freemium flows, named, as drafts |
| Not sure yet, skipped, or an unknown value | The general welcome, unchanged |

Flow names are read from the real template, so the email cannot promise flows that do not exist. Code:
`goalWelcome` and `buildWelcomeEmail` in `packages/api/src/transactional-email.ts`. The stall nudge email is not
goal-specific: it follows the step they are on, which matters more by then.

## Sample event (no API key)

The "Send your first event" step normally needs the customer's own app to call the API, which needs a key. To let
them see the whole path first, the step and the Integrate page have a **Send me a sample** button. It fires a real
`signed_up` event for the signed-in person's own address, with no key:

- `POST /v1/onboarding/sample-event` (any member). It uses the same code as `POST /v1/track`, so it starts flows
  and counts against plan limits exactly like a real event (402 at the contact limit).
- The address is always the caller's own. The endpoint takes no email or user id, so it cannot be pointed at
  someone else. The event carries `properties.sample = true`.
- One contact (`sample-event-user`) is reused, so repeats never add contacts. Most flows run once per contact, so a
  second sample may not send another email, and the screen says so.
- Five per workspace per hour, then 429 with `Retry-After` (in memory, per process).
- The reply says whether a flow is on and whether anything can send, and the screen tells them what is missing
  ("no flow is turned on yet", "nothing is set up to send email yet") instead of leaving them waiting.
- It also completes the "first event" step, like any received event.

## Goal picker at signup

The signup form asks one optional question, "What do you want to do first?", with four answers: welcome new
signups, turn trial users into paying customers, move free users to a paid plan, or not sure yet. Skipping it never
blocks signup, and an unknown value is ignored. The answer is stored as `tenants.settings.signup.goal`, and a link can
pre-select it (`/signup?goal=convert_trials`).

Everyone still turns on the Welcome flow first, because it needs no AI setup. The goal decides what comes next:
once the Welcome flow is on, Home shows a card for the two goals that have a ready-made template:

| Goal | Offered next | Drafts created |
|------|--------------|----------------|
| Turn trial users into paying customers | Time-Limited Trial | 5 |
| Move free users to a paid plan | Freemium | 5 |

One click applies the template as **drafts**: nothing sends until the customer reviews, compiles and switches each
one on. Applying sets the workspace's lifecycle timing and throttle for that business model, and can only be done once
per workspace, so the card disappears afterwards. `GET /v1/onboarding` returns `goal` and `goal_suggestion`.
The admin funnel shows how many signups chose each goal. Mapping: `GOAL_INFO` in `packages/core/src/onboarding.ts`.

## Sending works from minute one

When the operator offers Mailforge Sending (`MAILFORGE_MANAGED_RESEND_API_KEY`) **and** a shared sender address
(`MAILFORGE_MANAGED_SHARED_FROM`), every new signup gets Mailforge Sending switched on automatically. Their first
email goes out from the shared address (capped by `MAILFORGE_MANAGED_SHARED_DAILY_LIMIT`, default 100 a day) with no
provider or SMTP setup, and the "Choose how email is sent" step shows as done. They can add their own domain later.

- Without a shared address nothing is auto-enabled: it would wait for a verified domain and the workspace would
  look set up when it is not.
- `MAILFORGE_SIGNUP_AUTO_SENDING=false` turns auto-enable off while keeping Mailforge Sending available.
- The "sender" step counts as done only when mail can really go out: an own transport, or Mailforge Sending that is
  on and has the shared address or a verified domain.
- Existing workspaces are never changed. Abuse limits still apply (bounce and complaint auto-pause, daily cap).

## "Emails are waiting" warning

Approved email that cannot go out is shown on Home instead of sitting silent. `GET /v1/onboarding` returns
`waiting_emails` (counted up to 100) and `waiting_reason`:

| Reason | Meaning | Link |
|--------|---------|------|
| `no_sender` | Nothing set up to send through | Settings > Email sending |
| `needs_domain` | Mailforge Sending is on but has no shared address or verified domain | Settings > Email sending |
| `paused` | Mailforge Sending is paused for the workspace | Settings > Email sending |
| `no_address` | Sender is fine but no postal address (the drain refuses to send) | Settings > Postal address |

No warning when nothing is waiting, or when the setup is fine and mail is simply queued for its send window.
Rules: `waitingReason` in `packages/core/src/onboarding.ts`.

## Stall nudges

A workspace that signed in but stopped gets at most **two** reminder emails, each naming the one step that
is next and linking straight to it:

| Nudge | Sent when |
|-------|-----------|
| 1st | 24 hours after the welcome email, onboarding not finished |
| 2nd ("Last reminder") | 72 hours after the welcome email and 24 hours after the 1st |

Left alone: workspaces that finished, that chose **I will finish this later** (the email says that button is how
to stop them), that are suspended or being deleted, whose trial has ended, that did not come through signup, or
that never signed in. Sent to active owners only, from the platform sender (`PLATFORM_*`).

An hourly sweep inside the server runs it (`startOnboardingNudgeMonitor`), only when plans are enforced and a
platform sender is set. Each nudge is claimed with one compare-and-set UPDATE, so overlapping sweeps or two
servers cannot send the same one; a refused delivery puts the counters back so the next sweep retries.
Timing rules: `nudgeDue` in `packages/core/src/onboarding.ts`. Counters: `nudge_count`, `last_nudge_at`.

## API

```
GET   /v1/onboarding   { hosted, steps[], done, total, percent, complete, next, minutes_left,
                         has_ingest_key, dismissed, completed_at }
PATCH /v1/onboarding   { dismissed: true | false }
```

Stored under `tenants.settings.onboarding`: `dismissed_at`, `completed_at`, `welcome_sent_at`, `nudge_count`, `last_nudge_at`.

## Seeing where customers stall

The admin console Overview has this as a live **Signup funnel** (see guide/ADMIN.md). Everything is also queryable by hand. Activation funnel for workspaces created in the last 30 days:

```sql
SELECT
  count(*)                                                        AS signups,
  count(*) FILTER (WHERE settings->'onboarding'->>'welcome_sent_at' IS NOT NULL) AS signed_in,
  count(*) FILTER (WHERE coalesce(settings->>'postal_address','') <> '')         AS added_address,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.tenant_id = t.id)) AS sent_event,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lifecycle_messages m
                                 WHERE m.tenant_id = t.id AND m.status = 'sent'))  AS first_email,
  count(*) FILTER (WHERE settings->'onboarding'->>'completed_at' IS NOT NULL)    AS completed
FROM tenants t
WHERE settings ? 'signup' AND created_at > now() - interval '30 days';
```

`signed_in` counts the welcome email, so it reads 0 if no platform sender is configured. `completed_at` is only written when someone opens the dashboard after finishing, so treat `first_email`
as the more reliable "activated" count.

## Changing the steps

Steps, wording, minutes and links live in one place: `packages/core/src/onboarding.ts`
(`STEP_DEFS`). The welcome email text is in `packages/api/src/transactional-email.ts`
(`buildWelcomeEmail`); keep its "about N minutes" in step with the sum of the step minutes.

## Not built yet

- Nudging workspaces that never signed in after signup (needs its own wording: no welcome email exists yet).
