import { describe, it, expect } from "vitest";
import { MAILFORGE_CORE_VERSION } from "../src/index.js";

describe("@mailforge/core", () => {
  it("exports version", () => {
    expect(MAILFORGE_CORE_VERSION).toBe("0.0.0");
  });
});
