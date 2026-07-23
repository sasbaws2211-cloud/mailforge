import { describe, it, expect } from "vitest";
import { CLAROS_SCHEDULER_VERSION } from "../src/index.js";

describe("@claros/scheduler", () => {
  it("exports version", () => {
    expect(CLAROS_SCHEDULER_VERSION).toBe("0.0.0");
  });
});
