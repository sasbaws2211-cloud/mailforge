/**
 * The "Add Loomail to your app" guides on the Integrate page: for each framework, the steps and code to paste, with the
 * workspace's address and publishable key filled in. No React, no network.
 *
 * Two groups. "In the browser" guides use the publishable key (safe in browser code) and keep it in the framework's
 * public environment variables rather than in the source. The plain HTML snippet needs no build step and works
 * everywhere; the others use the @loomail/browser package (packages/sdk-browser), which follows client-side route changes
 * for page views. "From your server" guides use a secret key from the environment and the official server SDK for that
 * language (Node, Python, PHP/Laravel, Ruby/Rails, Go, Java); the secret key is never filled in, only named.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */

export type FrameworkId =
  | "html" | "react" | "nextjs" | "vue" | "nuxt" | "svelte" | "angular" | "javascript" | "gtm"
  | "node" | "python" | "php" | "ruby" | "go" | "java";

export type FrameworkGroup = "browser" | "server";

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

export const FRAMEWORKS: ReadonlyArray<{ id: FrameworkId; label: string; group: FrameworkGroup }> = [
  { id: "html", label: "HTML", group: "browser" },
  { id: "react", label: "React", group: "browser" },
  { id: "nextjs", label: "Next.js", group: "browser" },
  { id: "vue", label: "Vue", group: "browser" },
  { id: "nuxt", label: "Nuxt", group: "browser" },
  { id: "svelte", label: "SvelteKit", group: "browser" },
  { id: "angular", label: "Angular", group: "browser" },
  { id: "javascript", label: "JavaScript", group: "browser" },
  { id: "gtm", label: "Tag Manager", group: "browser" },
  { id: "node", label: "Node.js", group: "server" },
  { id: "python", label: "Python", group: "server" },
  { id: "php", label: "PHP / Laravel", group: "server" },
  { id: "ruby", label: "Ruby / Rails", group: "server" },
  { id: "go", label: "Go", group: "server" },
  { id: "java", label: "Java", group: "server" },
];

export const FRAMEWORK_GROUPS: ReadonlyArray<{ id: FrameworkGroup; label: string; hint: string }> = [
  { id: "browser", label: "In the browser", hint: "Track page views and what people do on your site or app. Uses a publishable key." },
  { id: "server", label: "From your server", hint: "Send events from your backend: sign-ups, payments, anything that happens off the page. Uses a secret key." },
];

export const PACKAGE_NAME = "@loomail/browser";
export const KEY_PLACEHOLDER = "PASTE_YOUR_PUBLISHABLE_KEY";
export const SECRET_PLACEHOLDER = "PASTE_YOUR_SECRET_KEY";

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

const serverEnv = (g: GuideInput): GuideStep => ({
  title: "Add your key and address",
  file: ".env (or your host's environment settings)",
  code: `LOOMAIL_SECRET_KEY=${SECRET_PLACEHOLDER}\nLOOMAIL_HOST=${clean(g.origin)}`,
  note: "Use a secret key, created under API keys below: it can read and write, so it belongs on your server only and never in browser code. The SDK refuses a publishable key (mf_pub_...).",
});

const SERVER_NOTE = "Every call carries a message id, so a retry never double-counts. Pass your own (for example paid:invoice-42) to make a repeat safe across restarts.";

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
        summary: "Angular 15 and newer, with the standalone setup the CLI generates today. A service owns the client; the Angular router is followed automatically.",
        steps: [
          install(),
          {
            title: "Create the environment files",
            code: "ng generate environments",
            note: "New Angular projects do not have src/environments yet. This creates environment.ts (used by production builds) and environment.development.ts (used by ng serve).",
          },
          {
            title: "Add your key and address to both files",
            file: "src/environments/environment.ts and environment.development.ts",
            code: ["export const environment = {", `  loomailKey: "${key}",`, `  loomailHost: "${origin}",`, "};"].join("\n"),
            note: "Put the same two values in both files: ng serve uses the development one, and the build fails to compile if either is missing them. A publishable key is meant for browser code. Never use a secret key (mf_live_...) here.",
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
            file: "src/app/app.ts",
            code: [
              'import { Component, inject } from "@angular/core";',
              'import { LoomailService } from "./loomail.service";',
              "",
              "export class App {",
              "  private loomail = inject(LoomailService); // creating the service starts page tracking",
              "}",
              "",
              "// in any component:",
              "this.loomail.client.identify(user.id, { email: user.email }); // after sign-in",
              "this.loomail.client.reset();                                   // on sign-out",
              'this.loomail.client.track("clicked_upgrade");',
            ].join("\n"),
            note: "The root component is src/app/app.ts with a class named App in current Angular, and app.component.ts with AppComponent in older projects; inject the service in whichever yours is.",
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

    case "node":
      return {
        id,
        label: "Node.js",
        summary: "Express, Fastify, Next.js route handlers, NestJS, serverless functions: anything on Node 18 or newer.",
        steps: [
          { title: "Install the SDK", code: "npm install @loomail/node" },
          serverEnv(g),
          {
            title: "Send events",
            code: [
              'import { Loomail } from "@loomail/node";',
              "",
              "const loomail = new Loomail(); // reads LOOMAIL_SECRET_KEY and LOOMAIL_HOST",
              "",
              'await loomail.identify(user.id, { email: user.email, plan: "trial" });',
              'await loomail.track(user.id, "signed_up", { source: "ads" });',
              'await loomail.track(user.id, "invoice_paid", { amount: 4900 }, { messageId: `paid:${invoice.id}` });',
            ].join("\n"),
            note: `${SERVER_NOTE} For fire-and-forget, catch the error: loomail.track(...).catch(log).`,
          },
        ],
      };

    case "python":
      return {
        id,
        label: "Python",
        summary: "Django, Flask, FastAPI, Celery, scripts: Python 3.9 or newer, sync and asyncio.",
        steps: [
          { title: "Install the SDK", code: "pip install loomail" },
          serverEnv(g),
          {
            title: "Send events",
            code: [
              "from loomail import Loomail",
              "",
              "loomail = Loomail()  # reads LOOMAIL_SECRET_KEY and LOOMAIL_HOST",
              "",
              'loomail.identify(user.id, {"email": user.email, "plan": "trial"})',
              'loomail.track(user.id, "signed_up", {"source": "ads"})',
              'loomail.track(user.id, "invoice_paid", {"amount": 4900}, message_id=f"paid:{invoice.id}")',
            ].join("\n"),
            note: `${SERVER_NOTE} In async code use AsyncLoomail with await.`,
          },
        ],
      };

    case "php":
      return {
        id,
        label: "PHP / Laravel",
        summary: "Laravel (auto-discovered, with a facade) or any PHP 8.1+ app.",
        steps: [
          { title: "Install the SDK", code: "composer require loomail/loomail" },
          serverEnv(g),
          {
            title: "Laravel: use the facade",
            code: [
              "use Loomail\\Laravel\\Facades\\Loomail;",
              "",
              "Loomail::identify($user->id, ['email' => $user->email, 'plan' => 'trial']);",
              "Loomail::track($user->id, 'signed_up', ['source' => 'ads']);",
              "Loomail::track($user->id, 'invoice_paid', ['amount' => 4900], ['message_id' => \"paid:{$invoice->id}\"]);",
            ].join("\n"),
            note: `${SERVER_NOTE} To keep a Loomail outage out of the request, call it from a queued job.`,
          },
          {
            title: "Any other PHP app",
            code: ["$loomail = new \\Loomail\\Client(); // reads LOOMAIL_SECRET_KEY and LOOMAIL_HOST", "$loomail->track('user_123', 'signed_up');"].join("\n"),
          },
        ],
      };

    case "ruby":
      return {
        id,
        label: "Ruby / Rails",
        summary: "Rails (picked up automatically, with ActiveJob helpers), Sinatra, Sidekiq, plain Ruby 3.0+.",
        steps: [
          { title: "Install the gem", code: "bundle add loomail" },
          serverEnv(g),
          {
            title: "Rails: send events",
            code: [
              "Loomail.identify(user.id, email: user.email, plan: \"trial\")",
              "Loomail.track(user.id, \"signed_up\", source: \"ads\")",
              "",
              "# on a background job, so a Loomail outage never slows the request:",
              "Loomail.track_later(user.id, \"invoice_paid\", { amount: 4900 }, message_id: \"paid:#{invoice.id}\")",
            ].join("\n"),
            note: `${SERVER_NOTE} The key can also go in config.loomail.secret_key or Rails credentials.`,
          },
          {
            title: "Any other Ruby app",
            code: ["loomail = Loomail::Client.new # reads LOOMAIL_SECRET_KEY and LOOMAIL_HOST", "loomail.track(\"user_123\", \"signed_up\")"].join("\n"),
          },
        ],
      };

    case "go":
      return {
        id,
        label: "Go",
        summary: "Any Go 1.21+ service. Standard library only; every call takes a context.",
        steps: [
          { title: "Install the SDK", code: "go get github.com/sasbaws2211-cloud/mailforge/packages/sdk-go" },
          serverEnv(g),
          {
            title: "Send events",
            code: [
              'import loomail "github.com/sasbaws2211-cloud/mailforge/packages/sdk-go"',
              "",
              "client, err := loomail.New() // reads LOOMAIL_SECRET_KEY and LOOMAIL_HOST",
              "if err != nil { log.Fatal(err) }",
              "",
              'client.Identify(ctx, user.ID, map[string]any{"email": user.Email, "plan": "trial"})',
              'client.Track(ctx, user.ID, "signed_up", map[string]any{"source": "ads"})',
              'client.Track(ctx, user.ID, "invoice_paid", map[string]any{"amount": 4900}, loomail.WithMessageID("paid:"+invoice.ID))',
            ].join("\n"),
            note: `${SERVER_NOTE} Failures are *loomail.Error values with a Code; use errors.As.`,
          },
        ],
      };

    case "java":
      return {
        id,
        label: "Java",
        summary: "Spring, Quarkus, Micronaut, plain Java 11+. No dependencies; the client is thread-safe, so make one and share it.",
        steps: [
          {
            title: "Add the dependency",
            file: "pom.xml",
            code: ["<dependency>", "  <groupId>site.loomail</groupId>", "  <artifactId>loomail</artifactId>", "  <version>0.1.0</version>", "</dependency>"].join("\n"),
            note: 'Gradle: implementation("site.loomail:loomail:0.1.0")',
          },
          serverEnv(g),
          {
            title: "Send events",
            code: [
              "import site.loomail.*;",
              "",
              "Loomail loomail = Loomail.fromEnvironment(); // reads LOOMAIL_SECRET_KEY and LOOMAIL_HOST",
              "",
              'loomail.identify(user.id(), Map.of("email", user.email(), "plan", "trial"));',
              'loomail.track(user.id(), "signed_up", Map.of("source", "ads"));',
              'loomail.track(user.id(), "invoice_paid", Map.of("amount", 4900),',
              '    CallOptions.builder().messageId("paid:" + invoice.id()).build());',
            ].join("\n"),
            note: `${SERVER_NOTE} trackAsync / identifyAsync return a CompletableFuture to keep a Loomail outage out of a request.`,
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

/** True when the guide needs the @loomail/browser package (browser guides except the plain script tag and Tag Manager). */
export const needsPackage = (id: FrameworkId): boolean => groupOf(id) === "browser" && id !== "html" && id !== "gtm";

export const groupOf = (id: FrameworkId): FrameworkGroup => FRAMEWORKS.find((f) => f.id === id)?.group ?? "browser";
