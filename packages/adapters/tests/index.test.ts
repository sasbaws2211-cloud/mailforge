import { describe, it, expect } from "vitest";
import { MAILFORGE_ADAPTERS_VERSION } from "../src/index.js";

describe("@mailforge/adapters", () => {
  it("exports version", () => {
    expect(MAILFORGE_ADAPTERS_VERSION).toBe("0.0.0");
  });
});
