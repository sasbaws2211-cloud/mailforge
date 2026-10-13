import { describe, it, expect } from "vitest";
import { LOOMAIL_CORE_VERSION } from "../src/index.js";

describe("@loomail/core", () => {
  it("exports version", () => {
    expect(LOOMAIL_CORE_VERSION).toBe("0.0.0");
  });
});
