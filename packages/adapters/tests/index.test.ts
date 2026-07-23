import { describe, it, expect } from "vitest";
import { CLAROS_ADAPTERS_VERSION } from "../src/index.js";

describe("@claros/adapters", () => {
  it("exports version", () => {
    expect(CLAROS_ADAPTERS_VERSION).toBe("0.0.0");
  });
});
