/**
 * Tests for @claros/core queue contract.
 *
 * Covers the queue name constant and payload type for SCAN - the one queue
 * defined in task 5. Additional queues added in Phase 2 get their own tests
 * in the same commit as the queue definition.
 */
import { describe, it, expect } from "vitest";
import { QUEUE, CLAROS_CORE_VERSION } from "../src/index.js";
import type { ScanJobData, QueueName } from "../src/index.js";

describe("@claros/core - version", () => {
  it("exports version", () => {
    expect(CLAROS_CORE_VERSION).toBe("0.0.0");
  });
});

describe("QUEUE constants", () => {
  it("SCAN is claros.scan", () => {
    expect(QUEUE.SCAN).toBe("claros.scan");
  });

  it("all queue names use the claros. prefix", () => {
    for (const [key, value] of Object.entries(QUEUE)) {
      expect(value, `QUEUE.${key}`).toMatch(/^claros\./);
    }
  });

  it("all queue names are unique", () => {
    const values = Object.values(QUEUE);
    expect(new Set(values).size).toBe(values.length);
  });

  it("QUEUE has exactly 1 entry in task 5", () => {
    // Updated when a new queue is added in Phase 2.
    expect(Object.keys(QUEUE)).toHaveLength(1);
  });

  it("QueueName is assignable from QUEUE values", () => {
    const names: QueueName[] = Object.values(QUEUE);
    expect(names).toHaveLength(1);
  });
});

describe("ScanJobData payload type", () => {
  it("ScanJobData is an empty-object shape", () => {
    const data: ScanJobData = {};
    expect(data).toEqual({});
  });
});
