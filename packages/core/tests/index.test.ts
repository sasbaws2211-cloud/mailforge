import { describe, it, expect } from "vitest";
import { CLAROS_CORE_VERSION } from "../src/index.js";

describe("@claros/core", () => {
  it("exports version", () => {
    expect(CLAROS_CORE_VERSION).toBe("0.0.0");
  });
});
