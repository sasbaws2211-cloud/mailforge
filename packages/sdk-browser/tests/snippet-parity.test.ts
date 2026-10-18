// @vitest-environment jsdom
/** The hosted /loomail.js snippet and this client must agree about who the visitor is on a page that uses both. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLoomail } from "../src/index.js";

const snippet = readFileSync(resolve(process.cwd(), "../../apps/dashboard/public/loomail.js"), "utf8");

describe("snippet parity", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Reflect.deleteProperty(window, "loomail");
  });

  it("the client picks up the person the snippet identified, and the snippet picks up the client's", () => {
    const sent: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return Promise.resolve(new Response("{}"));
    });
    // load the real snippet
    (0, eval)(snippet);
    const w = window as unknown as { loomail: (...a: unknown[]) => void };
    w.loomail("init", "mf_pub_a", { endpoint: "https://loomail.test" });
    w.loomail("identify", "from_snippet");

    const client = createLoomail({ key: "mf_pub_a", endpoint: "https://loomail.test", transport: (url, body) => sent.push({ url, body: JSON.parse(body) }) });
    expect(client.userId()).toBe("from_snippet");
    client.track("from_client");
    expect(sent.at(-1)!.body).toMatchObject({ userId: "from_snippet", event: "from_client" });

    client.identify("from_client_user");
    w.loomail("track", "from_snippet_event");
    expect(sent.at(-1)!.body).toMatchObject({ userId: "from_client_user", event: "from_snippet_event" });
    // and the same anonymous id on both sides
    expect(sent.at(-1)!.body.context.anonymousId).toBe(client.anonymousId());
    vi.unstubAllGlobals();
  });
});
