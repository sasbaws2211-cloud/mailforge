import { describe, it, expect } from "vitest";
import { CLAROS_WORKER_VERSION } from "../src/index.js";

describe("@claros/worker", () => {
  it("exports version", () => {
    expect(CLAROS_WORKER_VERSION).toBe("0.0.0");
  });
});
