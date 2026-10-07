# Billing with Paystack

Mailforge sells Starter, Growth and Scale as card subscriptions, monthly or yearly,
through Paystack. Billing is **off** until you configure it; until then the Plan
page shows a "Contact us" link instead of an upgrade button.

## 1. Set up Paystack (you do this, with your own account)

1. Create a Paystack account and, for real money, finish business verification.
2. Check which **currencies** your account can charge (Settings, Preferences). Mailforge
   prices are in **USD**, and a charge must be in the same currency as its plan. If your
   account can only charge your local currency (NGN, GHS, ...), read "Currency" under
   Known limits before you go further.
3. Start in **test mode**: copy the test **secret key** (`sk_test_...`) from
   Settings, API Keys & Webhooks.
4. On the same page, set the **Test Webhook URL** to
   `https://<your-domain>/webhooks/paystack`. (There is no separate webhook secret:
   Paystack signs every webhook with your secret key, and Mailforge checks that signature.)
5. Put the key in `.env` yourself:

```
PAYSTACK_SECRET_KEY=sk_test_...
PAYSTACK_CURRENCY=USD
```

To charge in another currency, for example Ghana cedis, also set the exchange rate:

```
PAYSTACK_CURRENCY=GHS
PAYSTACK_USD_RATE=15.5      # cedis per 1 US dollar; see "Charging in another currency"
```

6. Restart the app. The Plan page now shows Choose buttons (owners only).

Switch to the live key (`sk_live_...`) and the **Live Webhook URL** only after a full
test-mode run: pay, renewal, cancel.

## Charging in another currency

Prices are set in US dollars (`packages/core/src/plans.ts`). With `PAYSTACK_CURRENCY` other than USD,
the charge is **the USD price times `PAYSTACK_USD_RATE`, rounded up to a whole unit**:

| Plan | USD | GHS at 15.5 |
|---|---|---|
| Starter | $19 / mo, $190 / yr | GHS 295 / mo, 2,945 / yr |
| Growth | $49 / mo, $490 / yr | GHS 760 / mo, 7,595 / yr |
| Scale | $129 / mo, $1,290 / yr | GHS 2,000 / mo, 19,995 / yr |

- **The rate is a fixed number you set**, not a live feed. A customer's price is locked when they
  subscribe: Paystack plans are created per amount, so changing the rate gives new subscribers
  the new price and leaves existing subscribers on the price they signed up for.
- Pick the market rate plus a margin for the cedi moving against you, and review it from time to
  time (restart the app after changing it).
- **If the currency is not USD and the rate is missing or not a plain positive number, billing is
  switched OFF** and the server logs why. This is deliberate: without it the dollar figure would
  be charged in cedis (about fifteen times too little).
- Amounts are always whole units, so a customer never sees a charge with pesewas.
- The Plan page and pricing page show the dollar list price and what is actually billed, and the
  admin console counts revenue in dollars at the list price, not the local amount.
- A payment is only accepted if it is in the checkout's currency and at least its amount, so a
  payment of "49" in cedis is rejected rather than treated as a $49 payment.

## 2. How it behaves

- **Customers pay in a popup, on the Plan page.** Choosing a plan opens Paystack's inline payment
  window over the page (no redirect). While it is open the page polls
  `GET /v1/billing/checkouts/:reference` every 2.5 seconds; the server asks Paystack about that
  payment (at most once every 2 seconds per checkout) and applies it if it was paid, so the page
  updates by itself the moment the payment goes through, with or without a webhook. Closing the
  popup shows "Checkout was cancelled. Nothing was charged." after an 8 second grace period
  (in case the payment landed just before). The page never trusts the popup's own "success" event.
- **Fallback:** if Paystack's script cannot be loaded (blocked, offline) or Paystack sends no
  access code, the browser is sent to the hosted checkout page and returns to `/billing/return`
  as before. That page and the webhook keep working either way.
- **Test data:** Paystack refuses some email domains (for example `.example`) with "Invalid
  Email Address Passed"; use a normal-looking address when testing.
- **Money is only believed after Mailforge asks Paystack.** A webhook or browser
  redirect just triggers a lookup of the transaction by its reference; the plan changes
  only if the lookup says `success`, in the right currency, for at least the expected
  amount (amounts are compared in minor units, so 4900 means 49.00).
- **Webhooks are signed.** Every request needs a valid `x-paystack-signature` (HMAC
  SHA-512 of the exact body under the secret key); anything else gets 401 and nothing runs.
- **Each charge counts once**, even if Paystack delivers the webhook several times.
- **Yearly** bills the exact yearly price (10 x monthly), once a year (Paystack's
  `annually` interval).
- **Changing plan** starts the new plan at once with a new charge, and cancels the old
  subscription. There is no proration: the unused part of the old period is not refunded.
- **Cancel** stops future charges; the plan stays until the end of the paid period,
  then the workspace falls to Free. Nothing is deleted. A customer who cancels from
  Paystack's own emails, or you from the Paystack dashboard, is picked up through the
  `subscription.disable` and `subscription.not_renew` webhooks.
- **Failed renewal**: the plan keeps working for 3 days (grace) and the Plan page warns.
  After that the workspace is on Free until paid. Paystack retries failed charges itself.
- A workspace whose plan was set by hand (no payment record) never lapses.
- A charge arriving after the customer cancelled is recorded and flagged
  "refund may be due" in `billing_events` for you to handle in Paystack.
- A payment still in progress, or closed without paying, leaves the checkout open
  instead of marking it failed, because the customer may still finish it.

Webhook events used: `charge.success` (first payment and every renewal),
`subscription.create` (learn the subscription code so it can be cancelled),
`subscription.disable` and `subscription.not_renew` (cancellation). Others are
acknowledged and ignored.

## 3. Testing

Use Paystack test mode (a `sk_test_` key and the Test Webhook URL): pay with Paystack's test
cards, then check the Plan page, `subscriptions` and `billing_events`. Paystack's dashboard
shows each webhook delivery and the status your server answered with.

The repository has no fake payment provider. The signature rules are unit tested
(`tests/paystack-signature.test.ts`) and the plan-lapse rules run against a real database
(`tests/billing-entitlements.db.test.ts`); the payment flow itself is only exercised by a
real test-mode run.

## 4. Known limits

- **Not yet exercised against the real Paystack API.** The payment flow was built from
  Paystack's documentation and has no automated test. Run the test-mode pass in step 1 before launch.
  Points to watch:
  - `subscription.create` payload fields and the order it arrives in relative to
    `charge.success`;
  - looking a customer's subscriptions up (`GET /customer/:email`, then
    `GET /subscription?customer=<id>`), which is only the fallback when the code was not
    learned from the webhook;
  - the `cancel_action` URL (sent in `metadata`) that returns the customer when they
    close the payment page;
  - that a transaction initialised with a plan really bills the plan amount in your currency.
- **Currency.** Paystack charges in a currency your account has enabled. If USD is not enabled
  for your business, use your local currency with `PAYSTACK_USD_RATE` (see above). The rate is
  fixed by you; it does not follow the market on its own.
- Renewals are matched by payer email, the Paystack plan code, and amount. If one email
  pays for two workspaces on the same plan, a renewal can be ambiguous (the one due first
  is renewed).
- Paystack ties a subscription to the customer's email; it cannot be changed.
- Card only for subscriptions. Mobile-money and bank-transfer customers cannot subscribe.
- Legal pages are templates: have a lawyer review them.
