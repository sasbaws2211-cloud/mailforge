# Billing with Flutterwave

Mailforge sells Starter, Growth and Scale as card subscriptions, monthly or yearly,
through Flutterwave. Billing is **off** until you configure it; until then the Plan
page shows a "Contact us" link instead of an upgrade button.

## 1. Set up Flutterwave (you do this, with your own account)

1. Create a Flutterwave account and, for real money, finish business verification.
2. Make sure **USD** is enabled for collecting payments (Settings, Payment methods /
   currencies). Prices are in USD and a charge must be in the same currency as its plan.
3. Start in **test mode**: copy the test **secret key** (`FLWSECK_TEST-...`).
4. Settings, Webhooks:
   - URL: `https://<your-domain>/webhooks/flutterwave`
   - Secret hash: invent a long random string (for example `openssl rand -hex 32`).
     Flutterwave sends it back on every webhook; Mailforge rejects anything without it.
5. Put both values in `.env` yourself:

```
FLUTTERWAVE_SECRET_KEY=FLWSECK_TEST-...
FLUTTERWAVE_WEBHOOK_HASH=<the same random string>
FLUTTERWAVE_CURRENCY=USD
```

6. Restart the app. The Plan page now shows Choose buttons (owners only).

Switch to live keys only after a full test-mode run: pay, renewal, cancel.

## 2. How it behaves

- **Money is only believed after Mailforge asks Flutterwave.** A webhook or browser
  redirect just triggers a lookup of the transaction; the plan changes only if the
  lookup says successful, in the right currency, for at least the expected amount.
- **Each charge counts once**, even if Flutterwave delivers the webhook several times.
- **Yearly** bills the exact yearly price (10 x monthly), once a year.
- **Changing plan** starts the new plan at once with a new charge, and cancels the old
  subscription. There is no proration: the unused part of the old period is not refunded.
- **Cancel** stops future charges; the plan stays until the end of the paid period,
  then the workspace falls to Free. Nothing is deleted.
- **Failed renewal**: the plan keeps working for 3 days (grace) and the Plan page warns.
  After that the workspace is on Free until paid. Flutterwave retries failed charges
  itself.
- A workspace whose plan was set by hand (no payment record) never lapses.
- A charge arriving after the customer cancelled is recorded and flagged
  "refund may be due" in `billing_events` for you to handle in Flutterwave.

## 3. Trying it without Flutterwave

```
docker compose -f docker-compose.yml -f docker-compose.mailpit.yml -f docker-compose.fakepay.yml up -d
```

This runs a fake Flutterwave at http://localhost:4010 (development only, fake keys).
Choose a plan, pick Pay / Declined / Cancel on the fake checkout, and use its control
page to trigger a renewal.

## 4. Known limits

- Not yet exercised against the real Flutterwave API. Run the test-mode pass in step 1
  before launch. Points to watch: the cancel endpoint, and whether Flutterwave requires
  a customer phone number on your account.
- Renewals are matched by payer email, amount and currency (plus plan id when sent). If
  one email pays for two workspaces, a renewal can be ambiguous.
- Card only. Mobile-money customers cannot subscribe.
- USD only.
- Legal pages are templates: have a lawyer review them.
