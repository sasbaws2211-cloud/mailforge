# Data export and workspace deletion

Every workspace owner can take their data with them or erase it, without asking you.
Platform admins can do both on a customer's behalf.

## For customers (Settings, Data & deletion)

**Export.** One click downloads a JSON file with everything held for the workspace:
contacts, events, flows and memberships, messages and delivery events, templates, the
knowledge base, suppressions, team, subscriptions and payment attempts. It is streamed,
so large workspaces work. Owners only, up to 5 a hour.

Never in the file: API key hashes, email provider and AI provider credentials, invite
and sign-in tokens, sessions, knowledge-base embedding vectors, checkout links. The
file says so at the top.

**Delete.** The owner types the workspace name to confirm. Then:

1. The workspace is switched off at once: dashboard, sending and the ingest API stop.
   The owner (and only the owner) can still download an export or **cancel the deletion**.
2. An active subscription is cancelled with Paystack first. If that fails, nothing is
   scheduled and the owner sees why.
3. After the grace period (7 days by default) the worker erases everything. It runs on
   the hourly background tick, so erasure happens within about an hour of the date.

Set the grace period with `MAILFORGE_DELETION_GRACE_DAYS` (1 to 90).

**The emails.** Three, each to every active owner of the workspace (not only whoever
clicked, and also when a platform admin did it):

- *Scheduled*, sent the moment deletion is scheduled: which workspace, the day it will be
  erased (UTC), who asked, and a link to sign in and cancel or export.
- *Cancelled*, sent when the deletion is called off: who cancelled it, that nothing was
  erased, and a warning to check the team if it was unexpected. This one is partly a
  security alert: a second owner cannot quietly undo a deletion you wanted.
- *Deleted*, sent after a platform admin uses **Erase immediately**: which workspace, which
  administrator, the day, and that it cannot be recovered. No sign-in link, because there
  is nothing left to sign in to. It includes `MAILFORGE_SUPPORT_EMAIL` as the place to write
  if you have set one. The admin's written reason is not included (it is an internal note).
  The owners, their email transport and the name are gone once the erase finishes, so the
  server looks them up first and sends afterwards, and only if the erase really happened.

They are account email, so there is no unsubscribe footer and suppression does not apply.
Each is sent from the workspace's own email transport if it has one, then from the platform
sender (`PLATFORM_*` settings). If neither works the change still happens and a warning is
logged; an email can never block or undo the request.

## What erasure removes, and what it keeps

Removed, in one database transaction (all or nothing): the workspace and every row in
every table that carries its id: team, sessions, API keys, contacts, events, flows,
messages, templates, knowledge base, suppressions, provider credentials, subscriptions,
checkout records and the rest. The list of tables is discovered from the database, so a
table added later is covered automatically, and a test fails if anything survives.

Kept, on purpose:

| What | Why | What it holds |
| --- | --- | --- |
| `deleted_workspaces` | prove that a deletion happened, and when | id, name, slug, plan, dates, how, rows erased per table, and the owner's email only as a SHA-256 hash |
| `billing_events` | payment records for your accounting | provider event id, type, outcome and the provider payload (which can include the payer's email). Detached from any workspace. |
| `admin_audit_log` | what operators did | the entries, detached, with the workspace name and slug written in |

If you must erase payment records too, or you operate where a different retention rule
applies, decide that with your lawyer and adjust `drizzle/purge/index.ts`.

Not covered: backups of your database (they age out on your backup schedule), emails
already sent to people (they hold what was sent), and the payment provider's own records.

## For platform admins

In the Admin console, on a workspace: **Download export**, **Delete workspace** (grace
period, undoable) and **Cancel scheduled deletion**. For legal erasure requests there is
**Erase immediately**, which skips the grace period and cannot be undone. Both need the
workspace slug typed and a written reason, and are written to the audit log. You cannot
delete your own workspace.

## Running the sweep by hand

The worker erases due workspaces on its hourly tick. To do it right now:

```
docker compose exec -T app sh -c "cd /app/packages/worker && node --input-type=module" < tools/run-purge-sweep.mjs
```

## Known limits

- Export is JSON only (no CSV, no zip).
- Owners are emailed when deletion is scheduled, cancelled, or done by an immediate admin
  erase. They are not emailed when the grace period simply runs out: the scheduling email
  already gave the date, and the owners are erased along with everything else.
- Background job queue entries that mention an erased workspace are not removed; they find
  nothing to act on and finish.
- The export rate limit is in memory, per process.
