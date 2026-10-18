// @vitest-environment node
/** Importing and creating the client on the server (no window) must be harmless. */
import { describe, it, expect } from "vitest";
import { createLoomail } from "../src/index.js";

describe("server-side rendering", () => {
  it("has no browser, and the client does nothing", () => {
    expect(typeof window).toBe("undefined");
    const l = createLoomail({ key: "mf_pub_a", endpoint: "https://loomail.test", autoPage: true });
    expect(l.active).toBe(false);
    expect(() => {
      l.identify("u");
      l.track("e");
      l.page();
      l.start();
      l.stop();
    }).not.toThrow();
  });
});
