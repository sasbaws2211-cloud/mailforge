# @loomail/browser

Browser client for [Loomail](https://loomail.site): identify people and track events from any web app, with helpers for React, Next.js and Vue. ESM and CommonJS, no runtime dependencies, written in TypeScript.

```bash
npm install @loomail/browser
```

Use a **publishable** key (`mf_pub_...`). It can write events and nothing else, so it is safe in browser code. A secret key (`mf_live_...`) is refused. Both are made on your Loomail **Integrate** page, which also has a copy-paste guide for each framework with your address and key filled in.

## React and Next.js

```tsx
import { LoomailProvider, useLoomail } from "@loomail/browser/react";

<LoomailProvider
  publishableKey={import.meta.env.VITE_LOOMAIL_KEY}   // process.env.NEXT_PUBLIC_LOOMAIL_KEY in Next.js
  endpoint="https://loomail.example.com"
  autoPage
  user={user ? { id: user.id, traits: { email: user.email } } : null}
>
  <App />
</LoomailProvider>

const loomail = useLoomail();
loomail.track("clicked_upgrade", { plan: "pro" });
```

- `user`: pass the signed-in person (`{ id, traits? }`) and the provider identifies them, once per id and traits. Pass `null` when nobody is signed in; it resets on the way from a person to `null` (logout). Leave it out to call `identify()` and `reset()` yourself.
- The entry is a client module (`"use client"`), so it works in the Next.js app router. Rendering on the server does nothing. In the pages router wrap `<Component />` in `pages/_app.tsx`.
- `useLoomail()` outside a provider does nothing, so a missing provider never crashes a page.

## Vue and Nuxt

```ts
import { createApp } from "vue";
import { loomailPlugin, useLoomail } from "@loomail/browser/vue";

createApp(App).use(loomailPlugin, { key: "mf_pub_...", endpoint: "https://loomail.example.com", autoPage: true }).mount("#app");

const loomail = useLoomail();      // in setup();  this.$loomail in the options API
loomail.identify(user.id, { email: user.email });
```

In Nuxt 3 install it from a client-only plugin (`plugins/loomail.client.ts`) with `nuxtApp.vueApp.use(loomailPlugin, ...)`.

## Svelte, Angular, Solid, Astro, plain TypeScript

```ts
import { createLoomail } from "@loomail/browser";

export const loomail = createLoomail({ key: "mf_pub_...", endpoint: "https://loomail.example.com", autoPage: true });
```

Create it once and import it where you need it (in Angular, in a service). Safe to import on the server: without a browser it does nothing.

## Options

| Option | Default | |
|---|---|---|
| `key` | | Publishable key. Required. |
| `endpoint` | | Your Loomail address, such as `https://loomail.example.com`. Required. |
| `autoPage` | `false` | Record a page view on start and on every client-side route change. |
| `trackRouteChanges` | `true` | With `autoPage`: follow route changes (History API: every client-side router). |
| `routeSettleMs` | `100` | How long the page title must stop changing before a page view is recorded (the first one and every route change), so it carries the new page's title: Angular, React and Next.js all set it a moment after the route renders. A redirect chain is recorded once; it never waits more than a second. |
| `anonymousTracking` | `false` | Send events from visitors who have not identified to the server. See below. |
| `startOptedOut` | `false` | Send and store nothing until `optIn()`. |
| `storage` | `localStorage` | Where the visitor is remembered. `null` keeps it in memory only. |

## Calls

- `identify(userId, traits?)` says who the visitor is. Call it when they sign up or log in. Events held while they were anonymous are sent with it.
- `track(event, properties?)` records something they did.
- `page(name?, properties?)` records a page view (`autoPage` does this for you).
- `reset()` on logout: the next person on this browser starts anonymous.
- `optIn()` / `optOut()` for consent. `optOut()` forgets the stored visitor and anything held.
- `userId()`, `anonymousId()`, `isOptedOut()`, `start()`, `stop()`.

## Anonymous visitors

Loomail people need a user id, so by default an anonymous visitor's events are **held in the browser** (up to 50 events, 48 hours) and sent under the real id, with their original times, when `identify()` runs. Visitors who never identify cost nothing and create no people.

With `anonymousTracking: true` they are sent to the server instead, kept against the anonymous id for 30 days, and moved onto the person when `identify()` runs. This keeps data about visitors who never sign up, so turn it on only where your privacy notice and consent setup allow it.

## Cookie banners

```ts
const loomail = createLoomail({ key, endpoint, autoPage: true, startOptedOut: true });
// when they accept:
loomail.optIn();      // starts, and records the page they are on
// if they withdraw:
loomail.optOut();     // forgets the stored visitor
```

## Good to know

- It never throws and never breaks your app. Network failures are swallowed.
- Events are sent with `navigator.sendBeacon` (falling back to `fetch` with `keepalive`) as a CORS-simple request, so there is no preflight and events survive a page unload.
- It shares its storage format with the hosted `/loomail.js` snippet, so a page may use both and they agree on who the visitor is.
- Events more than 72 hours from Loomail's clock are re-dated to now by the server.
- If your site has an origin allowlist on the publishable key, add the origin of every site that uses this package.
