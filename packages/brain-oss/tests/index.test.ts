import { describe, it, expect } from "vitest";
import { createOssBrain } from "../src/index.js";
import type { Brain, BrainConfig } from "../src/index.js";

describe("@mailforge/brain-oss", () => {
  it("createOssBrain returns a Brain implementation", () => {
    const cfg: BrainConfig = {};
    const brain: Brain = createOssBrain(cfg);
    expect(brain).toBeDefined();
    expect(typeof brain.decide).toBe("function");
    expect(typeof brain.draft).toBe("function");
  });

  it("decide stub returns skip (sends nothing until real prompts are wired)", async () => {
    const brain = createOssBrain({});
    const result = await brain.decide({});
    expect(result.action).toBe("skip");
  });
});
