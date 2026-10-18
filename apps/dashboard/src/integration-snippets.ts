/**
 * The "Add Loomail to your app" guides on the Integrate page: for each framework, the steps and code to paste, with the
 * workspace's address and publishable key filled in. No React, no network.
 *
 * Every guide uses the publishable key (safe in browser code) and keeps it in the framework's public environment
 * variables rather than in the source. The plain HTML snippet needs no build step and works everywhere; the others use
 * the @loomail/browser package (packages/sdk-browser), which follows client-side route changes for page views.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */

export type FrameworkId = "html" | "react" | "nextjs" | "vue" | "nuxt" | "svelte" | "angular" | "javascript" | "gtm";

export interface GuideStep {
  title: string;
  /** What to paste into, such as "src/main.tsx". */
  file?: string;
  code: string;
  /** One line under the code. */
  note?: string;
}

export interface Guide {
  id: FrameworkId;
  label: string;
  /** What this guide is for, one line. */
  summary: string;
  steps: GuideStep[];
}

export const FRAMEWORKS: ReadonlyArray<{ id: FrameworkId; label: string }> = [
  { id: "html", label: "HTML" },
  { id: "react", label: "React" },
  { id: "nextjs", label: "Next.js" },
  { id: "vue", label: "Vue" },
  { id: "nuxt", label: "Nuxt" },
  { id: "svelte", label: "SvelteKit" },
  { id: "angular", label: "Angular" },
  { id: "javascript", label: "JavaScript" },
  { id: "gtm", label: "Tag Manager" },
];

export const PACKAGE_NAME = "@loomail/browser";
export const KEY_PLACEHOLDER = "PASTE_YOUR_PUBLISHABLE_KEY";

export interface GuideInput {
  /** Where this Loomail is served, such as https://loomail.example.com */
  origin: string;
  /** The publishable key, when it is known (just created). Otherwise a placeholder is shown. */
  key: string | null;
}

const clean = (origin: string) => origin.replace(/\/+$/, "");

/** The plain HTML snippet: a two-line stub, then the hosted script. */
export function buildSnippet(origin: string, rawKey: string | null): string {
  const k = rawKey ?? KEY_PLACEHOLDER;
  const o = clean(origin);
  return [
    "<script>",
    "  window.loomail = window.loomail || function () {",
    "    (window.loomail.q = window.loomail.q || []).push(arguments);",
    "  };",
    "</script>",
    `<script async src="${o}/loomail.js"></script>`,
    "<script>",
    `  loomail("init", "${k}", { endpoint: "${o}", autoPage: true });`,
    "  // When someone signs up or logs in (events from before this are kept and sent with it):",
    '  loomail("identify", "user_123", { email: "user@example.com" });',
    '  loomail("track", "signed_up");',
    "  // When they log out:",
    '  // loomail("reset");',
    "</script>",
  ].join("\n");
}

const install = (): GuideStep => ({ title: "Install the package", code: `npm install ${PACKAGE_NAME}` });
const env = (file: string, keyVar: string, hostVar: string, g: GuideInput): GuideStep => ({
  title: "Add your key and address",
  file,
  code: `${keyVar}=${g.key ?? KEY_PLACEHOLDER}\n${hostVar}=${clean(g.origin)}`,
  note: "A publishable key is meant for browser code: it can write events and nothing else. Never put a secret key (mf_live_...) here; the package refuses it.",
});

const SIGN_IN_NOTE = "Pass the signed-in person as the user prop and Loomail identifies them; pass null when nobody is signed in and it resets on logout.";

export function buildGuide(id: FrameworkId, g: GuideInput): Guide {
  const origin = clean(g.origin);
  const key = g.key ?? KEY_PLACEHOLDER;
  switch (id) {
    case "html":
      return {
        id,
        label: "HTML",
        summary: "No build step. Paste into your site's HTML, before the closing body tag. Works in any framework too.",
        steps: [{ title: "Paste the snippet", code: buildSnippet(origin, g.key), note: "It sends events without a CORS preflight and survives page unloads. For a single-page app, prefer the package for your framework: it also records a page view on every route change." }],
      };

    case "react":
      return {
        id,
        label: "React",
        summary: "React with Vite, Create React App or any bundler.",
        steps: [
          install(),
          env(".env", "VITE_LOOMAIL_KEY", "VITE_LOOMAIL_HOST", g),
          {
            title: "Wrap your app",
            file: "src/main.tsx",
            code: [
              'import { LoomailProvider } from "@loomail/browser/react";',
              "",
              "// user: the signed-in person from your own auth, or null. See below.",
              "root.render(",
              "  <LoomailProvider",
              "    publishableKey={import.meta.env.VITE_LOOMAIL_KEY}",
              "    endpoint={import.meta.env.VITE_LOOMAIL_HOST}",
              "    autoPage",
              "    user={user ? { id: user.id, traits: { email: user.email } } : null}",
              "  >",
              "    <App />",
              "  </LoomailProvider>,",
              ");",
            ].join("\n"),
            note: `${SIGN_IN_NOTE} With Create React App use REACT_APP_ instead of VITE_ and process.env.`,
          },
          {
            title: "Track what people do",
            file: "any component",
            code: ['import { useLoomail } from "@loomail/browser/react";', "", "const loomail = useLoomail();", 'loomail.track("clicked_upgrade", { plan: "pro" });'].join("\n"),
          },
        ],
      };

    case "nextjs":
      return {
        id,
        label: "Next.js",
        summary: "App router (and pages router). The provider is a client component, and rendering on the server does nothing.",
        steps: [
          install(),
          env(".env.local", "NEXT_PUBLIC_LOOMAIL_KEY", "NEXT_PUBLIC_LOOMAIL_HOST", g),
          {
            title: "Create a client provider",
            file: "app/providers.tsx",
            code: [
              '"use client";',
              'import { LoomailProvider } from "@loomail/browser/react";',
              "",
              "export function Providers({ user, children }: { user: { id: string; email: string } | null; children: React.ReactNode }) {",
              "  return (",
              "    <LoomailProvider",
              "      publishableKey={process.env.NEXT_PUBLIC_LOOMAIL_KEY!}",
              "      endpoint={process.env.NEXT_PUBLIC_LOOMAIL_HOST!}",
              "      autoPage",
              "      user={user ? { id: user.id, traits: { email: user.email } } : null}",
              "    >",
              "      {children}",
              "    </LoomailProvider>",
              "  );",
              "}",
            ].join("\n"),
            note: SIGN_IN_NOTE,
          },
          {
            title: "Use it in your root layout",
            file: "app/layout.tsx",
            code: ['import { Providers } from "./providers";', "", "export default async function RootLayout({ children }: { children: React.ReactNode }) {", "  const user = await getCurrentUser(); // your own auth, or null", "  return (", '    <html lang="en"><body><Providers user={user}>{children}</Providers></body></html>', "  );", "}"].join("\n"),
            note: "Pages router: wrap <Component /> with the same <LoomailProvider> in pages/_app.tsx. Route changes are followed automatically.",
          },
          {
            title: "Track what people do",
            file: "any client component",
            code: ['"use client";', 'import { useLoomail } from "@loomail/browser/react";', "", "const loomail = useLoomail();", 'loomail.track("clicked_upgrade", { plan: "pro" });'].join("\n"),
          },
        ],
      };

    case "vue":
      return {
        id,
        label: "Vue",
        summary: "Vue 3 with Vite or any bundler. Vue Router navigations are followed automatically.",
        steps: [
          install(),
          env(".env", "VITE_LOOMAIL_KEY", "VITE_LOOMAIL_HOST", g),
          {
            title: "Install the plugin",
            file: "src/main.ts",
            code: [
              'import { createApp } from "vue";',
              'import { loomailPlugin } from "@loomail/browser/vue";',
              'import App from "./App.vue";',
              "",
              "createApp(App)",
              "  .use(loomailPlugin, {",
              "    key: import.meta.env.VITE_LOOMAIL_KEY,",
              "    endpoint: import.meta.env.VITE_LOOMAIL_HOST,",
              "    autoPage: true,",
              "  })",
              '  .mount("#app");',
            ].join("\n"),
          },
          {
            title: "Identify people and track events",
            file: "a component",
            code: [
              "<script setup>",
              'import { useLoomail } from "@loomail/browser/vue";',
              "const loomail = useLoomail();",
              "",
              "// after sign-in:  loomail.identify(user.id, { email: user.email });",
              "// on sign-out:    loomail.reset();",
              "</script>",
              "",
              "<template>",
              `  <button @click="loomail.track('clicked_upgrade', { plan: 'pro' })">Upgrade</button>`,
              "</template>",
            ].join("\n"),
            note: "In the options API use this.$loomail.",
          },
        ],
      };

    case "nuxt":
      return {
        id,
        label: "Nuxt",
        summary: "Nuxt 3. Installed from a client-only plugin, so nothing runs on the server.",
        steps: [
          install(),
          {
            title: "Add your key and address",
            file: "nuxt.config.ts",
            code: ["export default defineNuxtConfig({", "  runtimeConfig: {", "    public: {", `      loomailKey: "${key}",`, `      loomailHost: "${origin}",`, "    },", "  },", "});"].join("\n"),
            note: "A publishable key is meant for browser code. Never use a secret key (mf_live_...) here. You can also set NUXT_PUBLIC_LOOMAIL_KEY and NUXT_PUBLIC_LOOMAIL_HOST.",
          },
          {
            title: "Create a client-only plugin",
            file: "plugins/loomail.client.ts",
            code: [
              'import { loomailPlugin } from "@loomail/browser/vue";',
              "",
              "export default defineNuxtPlugin((nuxtApp) => {",
              "  const config = useRuntimeConfig().public;",
              "  nuxtApp.vueApp.use(loomailPlugin, { key: config.loomailKey, endpoint: config.loomailHost, autoPage: true });",
              "});",
            ].join("\n"),
          },
          {
            title: "Identify people and track events",
            file: "a component",
            code: ['import { useLoomail } from "@loomail/browser/vue";', "", "const loomail = useLoomail();", "loomail.identify(user.id, { email: user.email }); // after sign-in", "loomail.reset();                                   // on sign-out", 'loomail.track("clicked_upgrade");'].join("\n"),
          },
        ],
      };

    case "svelte":
      return {
        id,
        label: "SvelteKit",
        summary: "SvelteKit (also plain Svelte with Vite). Safe on the server: it does nothing there.",
        steps: [
          install(),
          env(".env", "PUBLIC_LOOMAIL_KEY", "PUBLIC_LOOMAIL_HOST", g),
          {
            title: "Create the client",
            file: "src/lib/loomail.ts",
            code: [
              'import { createLoomail } from "@loomail/browser";',
              'import { PUBLIC_LOOMAIL_KEY, PUBLIC_LOOMAIL_HOST } from "$env/static/public";',
              "",
              "export const loomail = createLoomail({",
              "  key: PUBLIC_LOOMAIL_KEY,",
              "  endpoint: PUBLIC_LOOMAIL_HOST,",
              "  autoPage: true, // follows SvelteKit's client-side navigation",
              "});",
            ].join("\n"),
          },
          {
            title: "Start it with your layout",
            file: "src/routes/+layout.svelte",
            code: ["<script>", '  import "$lib/loomail";', "</script>", "", "<slot />"].join("\n"),
          },
          {
            title: "Identify people and track events",
            file: "a component",
            code: ['import { loomail } from "$lib/loomail";', "", "loomail.identify(user.id, { email: user.email }); // after sign-in", "loomail.reset();                                   // on sign-out", 'loomail.track("clicked_upgrade");'].join("\n"),
          },
        ],
      };

    case "angular":
      return {
        id,
        label: "Angular",
        summary: "Angular 15+. A service that owns the client; the Angular router is followed automatically.",
        steps: [
          install(),
          {
            title: "Add your key and address",
            file: "src/environments/environment.ts",
            code: ["export const environment = {", `  loomailKey: "${key}",`, `  loomailHost: "${origin}",`, "};"].join("\n"),
            note: "A publishable key is meant for browser code. Never use a secret key (mf_live_...) here.",
          },
          {
            title: "Create the service",
            file: "src/app/loomail.service.ts",
            code: [
              'import { Injectable } from "@angular/core";',
              'import { createLoomail } from "@loomail/browser";',
              'import { environment } from "../environments/environment";',
              "",
              '@Injectable({ providedIn: "root" })',
              "export class LoomailService {",
              "  readonly client = createLoomail({ key: environment.loomailKey, endpoint: environment.loomailHost, autoPage: true });",
              "}",
            ].join("\n"),
            note: "createLoomail does nothing during server-side rendering.",
          },
          {
            title: "Start it, then use it anywhere",
            file: "src/app/app.component.ts",
            code: [
              "export class AppComponent {",
              "  constructor(private loomail: LoomailService) {} // creating the service starts page tracking",
              "}",
              "",
              "// in any component:",
              'this.loomail.client.identify(user.id, { email: user.email }); // after sign-in',
              "this.loomail.client.reset();                                   // on sign-out",
              'this.loomail.client.track("clicked_upgrade");',
            ].join("\n"),
          },
        ],
      };

    case "javascript":
      return {
        id,
        label: "JavaScript",
        summary: "Any bundler and any framework not listed: Solid, Preact, Astro, Remix, Ember, plain TypeScript.",
        steps: [
          install(),
          {
            title: "Create the client once",
            file: "src/loomail.ts",
            code: [
              'import { createLoomail } from "@loomail/browser";',
              "",
              "export const loomail = createLoomail({",
              `  key: "${key}",`,
              `  endpoint: "${origin}",`,
              "  autoPage: true, // a page view on load and on every client-side route change",
              "});",
            ].join("\n"),
            note: "Use a publishable key (mf_pub_...), never a secret key (mf_live_...): the package refuses it. Keep the key in your framework's public environment variables rather than in the source. Safe to import on the server: without a browser it does nothing.",
          },
          {
            title: "Use it",
            code: ['loomail.identify("user_123", { email: "user@example.com" }); // when someone signs up or logs in', 'loomail.track("clicked_upgrade", { plan: "pro" });', "loomail.reset();                                                 // on logout"].join("\n"),
          },
          {
            title: "Cookie banner? Wait for consent",
            code: ["// createLoomail({ ..., startOptedOut: true }) sends and stores nothing until:", "loomail.optIn();", "// and if they withdraw consent:", "loomail.optOut(); // also forgets the stored visitor"].join("\n"),
          },
        ],
      };

    case "gtm":
      return {
        id,
        label: "Tag Manager",
        summary: "Google Tag Manager: one Custom HTML tag, no code deploy.",
        steps: [
          {
            title: "Add a Custom HTML tag",
            code: buildSnippet(origin, g.key),
            note: "In Tag Manager choose Tags, New, Custom HTML, paste this, and trigger it on All Pages. Call loomail(\"identify\", ...) from a second tag or your own code when someone signs in.",
          },
        ],
      };
  }
}

/** True when the guide needs the npm package (everything except the plain script tag and Tag Manager). */
export const needsPackage = (id: FrameworkId): boolean => id !== "html" && id !== "gtm";
