/**
 * Tests for the passkey screens' plain-language rules: what to tell a person when the
 * device says no, the default name for a new passkey, and how recent use is described.
 */
import { describe, it, expect } from "vitest";
import { lastUsedLabel, passkeyErrorMessage, passkeyRequiredNotice, suggestPasskeyName } from "../src/passkey-ui.js";
import { adminLoginNotice } from "../src/admin-auth.js";
import { adminTabFor } from "../src/admin.js";

const err = (name: string, code?: string) => Object.assign(new Error("raw browser text"), { name, code });

describe("passkeyErrorMessage", () => {
  it("a cancelled or timed-out prompt reads as that, worded for the action", () => {
    expect(passkeyErrorMessage(err("NotAllowedError"), "sign-in")).toBe("Sign-in was cancelled or timed out. Try again.");
    expect(passkeyErrorMessage(err("NotAllowedError"), "register")).toBe("Adding the passkey was cancelled or timed out. Try again.");
    expect(passkeyErrorMessage(err("AbortError"), "sign-in")).toContain("cancelled");
    expect(passkeyErrorMessage(err("Error", "ERROR_CEREMONY_ABORTED"), "sign-in")).toContain("cancelled");
  });

  it("a device that already has one says so", () => {
    expect(passkeyErrorMessage(err("InvalidStateError"), "register")).toBe("This device already has a passkey for the admin console.");
    expect(passkeyErrorMessage(err("Error", "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"), "register")).toContain("already has a passkey");
  });

  it("a page on the wrong kind of address explains what passkeys need", () => {
    expect(passkeyErrorMessage(err("SecurityError"), "sign-in")).toContain("https");
    expect(passkeyErrorMessage(err("Error", "ERROR_INVALID_RP_ID"), "register")).toContain("localhost");
  });

  it("an unsupported browser says so", () => {
    expect(passkeyErrorMessage(err("NotSupportedError"), "register")).toContain("does not support passkeys");
  });

  it("a plain message from our own server is passed through", () => {
    expect(passkeyErrorMessage(new Error("That passkey could not be verified."), "sign-in")).toBe("That passkey could not be verified.");
    expect(passkeyErrorMessage(new Error("You can register up to 10 passkeys. Remove one first."), "register")).toContain("up to 10");
  });

  it("anything unrecognised falls back to a useful sentence, never a raw error name", () => {
    expect(passkeyErrorMessage("boom", "sign-in")).toBe("Passkey sign-in did not work. Try again, or use an emailed link.");
    expect(passkeyErrorMessage(null, "register")).toBe("The passkey could not be added. Try again.");
    expect(passkeyErrorMessage(new Error("TypeError: x is not a function"), "sign-in")).not.toContain("TypeError");
  });
});

describe("suggestPasskeyName", () => {
  const ua = {
    chromeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
    chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  };

  it("names the browser and the system", () => {
    expect(suggestPasskeyName(ua.chromeWin)).toBe("Chrome on Windows");
    expect(suggestPasskeyName(ua.safariMac)).toBe("Safari on Mac");
    expect(suggestPasskeyName(ua.safariIphone)).toBe("Safari on iPhone");
    expect(suggestPasskeyName(ua.firefoxLinux)).toBe("Firefox on Linux");
  });

  it("tells Edge from Chrome, and Android from Linux", () => {
    expect(suggestPasskeyName(ua.edgeWin)).toBe("Edge on Windows");
    expect(suggestPasskeyName(ua.chromeAndroid)).toBe("Chrome on Android");
  });

  it("copes with nothing useful", () => {
    expect(suggestPasskeyName("")).toBe("This device");
    expect(suggestPasskeyName("curl/8.0")).toBe("This device");
  });
});

describe("lastUsedLabel", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  it("describes recent and old use", () => {
    expect(lastUsedLabel(null, now)).toBe("Never used");
    expect(lastUsedLabel("2026-10-04T08:00:00Z", now)).toBe("Used today");
    expect(lastUsedLabel("2026-10-03T08:00:00Z", now)).toBe("Used yesterday");
    expect(lastUsedLabel("2026-09-24T12:00:00Z", now)).toBe("Used 10 days ago");
    expect(lastUsedLabel("2026-01-15T00:00:00Z", now)).toBe("Used Jan 15, 2026");
  });
});

describe("sign-in page notices and tabs", () => {
  it("explains a passkey-required redirect, and only that value", () => {
    expect(adminLoginNotice("passkey_required")).toContain("passkey");
    expect(passkeyRequiredNotice("passkey_required")).toContain("passkey");
    expect(passkeyRequiredNotice("<script>")).toBeNull();
    expect(adminLoginNotice("something_else")).toBeNull();
  });

  it("the Security page lights the Security tab", () => {
    expect(adminTabFor("/admin/security")).toBe("security");
    expect(adminTabFor("/admin/security/")).toBe("security");
    expect(adminTabFor("/admin/securityx")).toBe("overview");
  });
});
