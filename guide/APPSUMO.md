# Selling Loomail on AppSumo

Loomail can be sold as a one-time lifetime deal on AppSumo. A buyer gets a **licence**, redeems it in a workspace, and
that workspace is on the **lifetime plan** for good. This page is the operator's guide: what to set up, how a buyer gets in,
and what happens on a refund.

## How it works

- **AppSumo tells Loomail what happened** by a signed webhook: `purchase`, `activate`, `upgrade`, `downgrade`, `deactivate`
  (a refund). Loomail only ever reacts to those. A licence is never created, upgraded or refunded by hand: AppSumo does not
  allow it, and the admin console has no button for it.
- **A buyer ties a licence to a workspace** in one of three ways: pressing *Activate* on AppSumo (the OAuth redirect), entering
  the code at `/redeem`, or pasting it under **Settings, Plan**.
- **One lifetime tier.** A workspace is on the lifetime plan while it holds a licence. There is no stacking: a second code in
  the same workspace is refused ("use this code in another workspace"). Any tier AppSumo reports counts as this one tier.
- **Refunds** (AppSumo's 60-day guarantee) deactivate the licence. The workspace goes onto *no plan*. Nothing is deleted.
- **Lifetime plans send through the customer's own email provider.** Loomail Sending (we send for them) is switched off when a
  code is redeemed and is not offered on these plans, so a one-time payment never carries a monthly sending cost.

## The plan

The limits live in `packages/core/src/plans.ts` (`lifetime_1`) and are monthly caps, never unlimited for anything that costs you
money. **Review them before you launch.**

| | Lifetime |
|---|---|
| Customer profiles | 1,000 |
| Emails per month | 10,000 |
| Team members | 2 |
| Loomail AI tokens per month | 300,000 |

AppSumo sets the price you charge; this only decides what the licence unlocks. Customers can still buy pay-as-you-go top-ups
(extra profiles, emails, AI credits) on the lifetime plan.

## Set it up

1. **Environment** (see `.env.example`):
   - `APPSUMO_API_KEY` signs webhooks (from the AppSumo partner portal).
   - `APPSUMO_CLIENT_ID` and `APPSUMO_CLIENT_SECRET` let Loomail turn an activation code into a licence key.
   - `APPSUMO_REDIRECT_URL` is `https://YOUR-DOMAIN/appsumo/callback`. Give AppSumo the same URL.
   - `APPSUMO_BUY_URL` is your product page on AppSumo. It powers the "Get the lifetime deal" buttons.
   - `ENCRYPTION_KEY` must be set (it is already needed for email credentials). It encrypts the one-hour "code waiting" cookie.
   - Plan limits must be enforced: `LOOMAIL_ENFORCE_PLANS=true`.
2. **Tell AppSumo** your webhook URL, `https://YOUR-DOMAIN/webhooks/appsumo`, and your redirect URL above.
3. **Admin console, Lifetime deals** (`/admin/lifetime`):
   - Choose a **billing mode**:
     - *Subscriptions and trial, and AppSumo codes can be redeemed* (the default): the normal 7-day trial and Essential plan, with
       a "Prefer to pay once?" offer on the pricing page once the buy link is set.
     - *Subscriptions only*: no lifetime offer shown.
     - *AppSumo lifetime deal only*: no trial and no card plans. A new workspace has no plan until a licence is redeemed, and the
       landing, pricing and signup pages say so.
   - Set **licences to sell** to the same number you give AppSumo. A warning shows when you are near it.
4. **Codes for AppSumo (optional).** If AppSumo wants a list of codes rather than using its licensing API, make them in the
   admin console (they look like `LM-XXXX-XXXX-XXXX`) and download the CSV: one code per line, no header. Give AppSumo the redeem
   address `https://YOUR-DOMAIN/redeem`. A code counts as sold only once someone redeems it. You can refund a code you made; a licence
   AppSumo reported can only be refunded by AppSumo.

## What a buyer sees

1. They buy on AppSumo and press **Activate**, or open `/redeem` and enter their code.
2. With no account yet, the code is kept for an hour and they are sent to sign up. After they open their sign-in link, **Settings,
   Plan** shows "You have an AppSumo code waiting" with a Redeem button.
3. With an account (owner), the code is claimed at once and they land on **Settings, Plan** on the lifetime plan.
4. A workspace with a **paid subscription** cannot redeem (the subscription would overwrite the plan at its next charge). They
   cancel the subscription first, or redeem in a new workspace.

## Trying it without AppSumo

```bash
APPSUMO_API_KEY=testkey node tools/appsumo-sim.mjs http://localhost:3010 purchase --key LIC-1 --tier 1
APPSUMO_API_KEY=testkey node tools/appsumo-sim.mjs http://localhost:3010 upgrade  --key LIC-2 --tier 1 --prev LIC-1
APPSUMO_API_KEY=testkey node tools/appsumo-sim.mjs http://localhost:3010 deactivate --key LIC-2
```

Then redeem `LIC-1` from **Settings, Plan** and watch the Lifetime deals page and its event log.

## Before you launch

- Put the server on the public internet with HTTPS (AppSumo must reach the webhook and the redirect).
- Check a real platform email sender works (sign-in links), because every buyer needs one.
- Decide your refund routine: AppSumo handles money; Loomail follows the webhook.
- Read the limits above against your costs: AI tokens are the one thing you pay for per customer on a lifetime plan.
