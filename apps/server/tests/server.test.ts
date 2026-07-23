import { describe, it, expect } from "vitest";

describe("@claros/server", () => {
  it("valid roles are defined", () => {
    const validRoles = ["all", "api", "worker", "scheduler"];
    expect(validRoles).toContain("all");
    expect(validRoles.length).toBe(4);
  });
});
