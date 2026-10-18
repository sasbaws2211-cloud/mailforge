/**
 * Vue 3 (and Nuxt 3) plugin.
 *
 *   import { createApp } from "vue";
 *   import { loomailPlugin } from "@loomail/browser/vue";
 *   createApp(App).use(loomailPlugin, { key: "mf_pub_...", endpoint: "https://loomail.example.com", autoPage: true }).mount("#app");
 *
 *   // in a component
 *   const loomail = useLoomail();
 *   loomail.track("clicked_upgrade");
 *   // or in a template / options API: this.$loomail.track("clicked_upgrade")
 *
 * Vue Router navigations go through the History API, so page views follow route changes with no router-specific code.
 * In Nuxt, install it from a client-only plugin (plugins/loomail.client.ts); on the server it does nothing anyway.
 *
 * Mirror side: PUBLIC (packages/sdk-browser is mirrored).
 */
import { inject, type App, type InjectionKey } from "vue";
import { createLoomail, createNoopClient, type LoomailClient, type LoomailOptions } from "./client.js";

export const LOOMAIL_KEY: InjectionKey<LoomailClient> = Symbol("loomail");

declare module "vue" {
  interface ComponentCustomProperties {
    $loomail: LoomailClient;
  }
}

export const loomailPlugin = {
  install(app: App, options: LoomailOptions | { client: LoomailClient }): void {
    const client = "client" in options ? options.client : createLoomail(options);
    app.provide(LOOMAIL_KEY, client);
    app.config.globalProperties.$loomail = client;
  },
};

/** The client, inside a component's setup(). Without the plugin it does nothing instead of crashing the page. */
export function useLoomail(): LoomailClient {
  return inject(LOOMAIL_KEY, null) ?? createNoopClient();
}
