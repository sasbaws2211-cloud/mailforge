import { describe, it, expect } from "vitest";
import { CLAROS_DASHBOARD_VERSION } from "../src/index.js";

describe("@claros/dashboard", () => {
  it("exports version", () => {
    expect(CLAROS_DASHBOARD_VERSION).toBe("0.0.0");
  });
});
