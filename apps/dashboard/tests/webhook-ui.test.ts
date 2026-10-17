/** Webhook step UI helpers: the address check and how a delivery is described. */
import { describe, it, expect } from "vitest";
import { webhookUrlIssue } from "../src/components/step-writer.js";
import { describeDelivery } from "../src/components/webhook-panels.js";

describe("webhookUrlIssue", () => {
  it("says nothing about an empty box (that is reported when saving)", () => {
    expect(webhookUrlIssue("")).toBeNull();
    expect(webhookUrlIssue("   ")).toBeNull();
  });
  it("accepts http and https addresses", () => {
    expect(webhookUrlIssue("https://hooks.example.com/in?x=1")).toBeNull();
    expect(webhookUrlIssue("http://localhost:9000/in")).toBeNull();
  });
  it("explains what is wrong", () => {
    expect(webhookUrlIssue("hooks.example.com")).toMatch(/not a web address/);
    expect(webhookUrlIssue("ftp://hooks.example.com")).toMatch(/https/);
    expect(webhookUrlIssue("https://user:pw@hooks.example.com")).toMatch(/username/);
  });
});

describe("describeDelivery", () => {
  const base = { attempts: 1, last_status_code: null, last_error: null, next_attempt_at: "2026-10-18T10:00:00Z" };
  it("says what happened to each kind of call", () => {
    expect(describeDelivery({ ...base, status: "succeeded", last_status_code: 200 })).toBe("Answered 200");
    expect(describeDelivery({ ...base, status: "pending", attempts: 0 })).toBe("Waiting to be sent");
    expect(describeDelivery({ ...base, status: "pending", last_error: "The server answered 503." })).toMatch(/The server answered 503\. Trying again .* \(attempt 1 of 6 so far\)\./);
    expect(describeDelivery({ ...base, status: "failed", last_error: "The server answered 404." })).toBe("The server answered 404.");
    expect(describeDelivery({ ...base, status: "failed" })).toBe("Failed");
  });
});
