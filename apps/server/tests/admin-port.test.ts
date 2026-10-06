/**
 * MAILFORGE_ADMIN_PORT decides whether the admin console runs as its own listener, so a
 * wrong value must stop the server rather than be guessed at.
 */
import { describe, it, expect } from "vitest";
import { parseAdminPort } from "../src/admin-port.js";

describe("parseAdminPort", () => {
  it("is off when unset or blank: the console stays inside the customer app", () => {
    expect(parseAdminPort(undefined, 3000)).toBeNull();
    expect(parseAdminPort("", 3000)).toBeNull();
    expect(parseAdminPort("   ", 3000)).toBeNull();
  });

  it("returns the port when it is valid and different from the main one", () => {
    expect(parseAdminPort("3011", 3010)).toBe(3011);
    expect(parseAdminPort(" 8443 ", 3010)).toBe(8443);
    expect(parseAdminPort("1", 3010)).toBe(1);
    expect(parseAdminPort("65535", 3010)).toBe(65535);
  });

  it("refuses anything that is not a usable port", () => {
    for (const bad of ["abc", "0", "-5", "65536", "30.5", "3011abc", "0x10"]) {
      expect(() => parseAdminPort(bad, 3010), bad).toThrow(/not a valid port/);
    }
  });

  it("refuses the main port: the console must be a separate surface", () => {
    expect(() => parseAdminPort("3010", 3010)).toThrow(/must differ from PORT/);
  });
});
