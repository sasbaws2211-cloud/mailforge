import { describe, it, expect } from "vitest";
import { CLAROS_API_VERSION } from "../src/index.js";

describe("@claros/api", () => {
  it("exports version", () => {
    expect(CLAROS_API_VERSION).toBe("0.0.0");
  });
});
