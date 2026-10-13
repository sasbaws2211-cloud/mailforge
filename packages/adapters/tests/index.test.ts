import { describe, it, expect } from "vitest";
import { LOOMAIL_ADAPTERS_VERSION } from "../src/index.js";

describe("@loomail/adapters", () => {
  it("exports version", () => {
    expect(LOOMAIL_ADAPTERS_VERSION).toBe("0.0.0");
  });
});
