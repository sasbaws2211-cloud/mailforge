// @vitest-environment jsdom
/** The React provider and hook. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LoomailProvider, useLoomail } from "../src/react.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { url: string; body: Record<string, any> };
let sent: Call[] = [];
let root: Root | null = null;
let container: HTMLElement;

// The provider creates its own client; capture what it sends by replacing the network.
beforeEach(() => {
  sent = [];
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.title = "App"; // a page with no title makes the client wait for one
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response("{}"));
  });
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

const render = (node: ReactNode) => {
  root = createRoot(container);
  act(() => root!.render(node));
};
const props = { publishableKey: "mf_pub_a", endpoint: "https://loomail.test" };
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 15)));
type U = { id: string; traits?: Record<string, string> } | null | undefined;
const tree = (user: U) => createElement(LoomailProvider, { ...props, user }, createElement("p", null, "app"));

describe("LoomailProvider", () => {
  it("records the first page once, even in strict mode, and follows route changes", async () => {
    render(createElement(StrictMode, null, createElement(LoomailProvider, { ...props, autoPage: true, anonymousTracking: true, routeSettleMs: 1 }, createElement("p", null, "app"))));
    await settle();
    expect(sent.filter((c) => c.body.event === "page_viewed")).toHaveLength(1);
    window.history.pushState(null, "", "/dashboard");
    await settle();
    expect(sent.map((c) => c.body.properties.path)).toEqual(["/", "/dashboard"]);
  });

  it("identifies the signed-in user once, again when they change, and resets on logout", () => {
    render(tree({ id: "u1", traits: { email: "a@b.co" } }));
    expect(sent.map((c) => c.url)).toEqual(["https://loomail.test/v1/identify"]);
    expect(sent[0]!.body).toMatchObject({ userId: "u1", traits: { email: "a@b.co" } });

    act(() => root!.render(tree({ id: "u1", traits: { email: "a@b.co" } }))); // same: nothing new
    expect(sent).toHaveLength(1);
    act(() => root!.render(tree({ id: "u1", traits: { email: "new@b.co" } }))); // traits changed
    expect(sent).toHaveLength(2);
    act(() => root!.render(tree({ id: "u2" })));
    expect(sent.at(-1)!.body.userId).toBe("u2");

    const aidBefore = sent.at(-1)!.body.context.anonymousId;
    act(() => root!.render(tree(null))); // logout
    act(() => root!.render(tree({ id: "u3" })));
    expect(sent.at(-1)!.body.context.anonymousId).not.toBe(aidBefore);
  });

  it("leaves identity alone when no user prop is given", () => {
    render(tree(undefined));
    expect(sent).toHaveLength(0);
  });

  it("useLoomail gives the same client to every child, and it works", () => {
    const seen: unknown[] = [];
    const Child = () => {
      const l = useLoomail();
      seen.push(l);
      return createElement("button", { onClick: () => l.track("clicked") }, "go");
    };
    render(createElement(LoomailProvider, { ...props, user: { id: "u1" } }, createElement(Child), createElement(Child)));
    expect(seen[0]).toBe(seen[1]);
    sent.length = 0;
    act(() => container.querySelector("button")!.click());
    expect(sent[0]!.body).toMatchObject({ userId: "u1", event: "clicked" });
  });

  it("useLoomail outside a provider does nothing and does not crash", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const Child = () => {
      useLoomail().track("x");
      return createElement("i");
    };
    expect(() => render(createElement(Child))).not.toThrow();
    expect(sent).toHaveLength(0);
    warn.mockRestore();
  });

  it("refuses a secret key", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(createElement(LoomailProvider, { ...props, publishableKey: "mf_live_x", user: { id: "u1" } }, createElement("p")));
    expect(sent).toHaveLength(0);
    err.mockRestore();
  });
});
