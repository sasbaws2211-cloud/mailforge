// @vitest-environment jsdom
/** The Vue plugin. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createApp, defineComponent, h } from "vue";
import { loomailPlugin, useLoomail } from "../src/vue.js";

type Call = { url: string; body: Record<string, any> };
let sent: Call[] = [];
beforeEach(() => {
  sent = [];
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.title = "App"; // a page with no title makes the client wait for one
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response("{}"));
  });
});

const options = { key: "mf_pub_a", endpoint: "https://loomail.test", autoPage: true, anonymousTracking: true, routeSettleMs: 1 };

describe("loomailPlugin", () => {
  it("provides the client to components, in setup and as $loomail, and tracks pages", async () => {
    let injected: ReturnType<typeof useLoomail> | undefined;
    let global: unknown = null;
    const Comp = defineComponent({
      setup() {
        injected = useLoomail();
        return () => h("button", { onClick: () => injected!.track("clicked") }, "go");
      },
      mounted() {
        global = (this as unknown as { $loomail: unknown }).$loomail;
      },
    });
    const el = document.createElement("div");
    const app = createApp(Comp).use(loomailPlugin, options);
    app.mount(el);
    expect(injected).toBe(global);
    await new Promise((r) => setTimeout(r, 15));
    expect(sent.filter((c) => c.body.event === "page_viewed")).toHaveLength(1);
    el.querySelector("button")!.click();
    expect(sent.at(-1)!.body.event).toBe("clicked");
    window.history.pushState(null, "", "/next");
    await new Promise((r) => setTimeout(r, 15));
    expect(sent.at(-1)!.body.properties.path).toBe("/next");
    app.unmount();
  });

  it("accepts a client you made yourself, and useLoomail without the plugin does nothing", () => {
    const own = { identify: vi.fn(), track: vi.fn(), page() {}, reset() {}, optIn() {}, optOut() {}, isOptedOut: () => false, start() {}, stop() {}, userId: () => null, anonymousId: () => null, active: true };
    let got: unknown;
    const Comp = defineComponent({
      setup() {
        got = useLoomail();
        return () => h("i");
      },
    });
    createApp(Comp).use(loomailPlugin, { client: own }).mount(document.createElement("div"));
    expect(got).toBe(own);

    let bare: ReturnType<typeof useLoomail> | undefined;
    const Bare = defineComponent({
      setup() {
        bare = useLoomail();
        return () => h("i");
      },
    });
    createApp(Bare).mount(document.createElement("div"));
    expect(bare!.active).toBe(false);
    expect(() => bare!.track("x")).not.toThrow();
  });
});
