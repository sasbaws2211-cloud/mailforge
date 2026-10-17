/**
 * Tests for @loomail/core queue contract.
 *
 * Covers the queue names and payload types defined in tasks 5, 11, 12b, 14, 15, and 22.
 * Additional queues added in Phase 2 get their own tests in the same commit.
 */
import { describe, it, expect } from "vitest";
import { QUEUE, LOOMAIL_CORE_VERSION } from "../src/index.js";
import type { ScanJobData, CompileJobData, TriggerCheckJobData, DrainJobData, ReapJobData, CounterRolloverJobData, PartitionMaintenanceJobData, ContentGenerationJobData, KbEmbedJobData, QueueName } from "../src/index.js";

describe("@loomail/core - version", () => {
  it("exports version", () => {
    expect(LOOMAIL_CORE_VERSION).toBe("0.0.0");
  });
});

describe("QUEUE constants", () => {
  it("SCAN is loomail.scan", () => {
    expect(QUEUE.SCAN).toBe("loomail.scan");
  });

  it("COMPILE is loomail.compile", () => {
    expect(QUEUE.COMPILE).toBe("loomail.compile");
  });

  it("TRIGGER_CHECK is loomail.trigger-check", () => {
    expect(QUEUE.TRIGGER_CHECK).toBe("loomail.trigger-check");
  });

  it("DRAIN is loomail.drain", () => {
    expect(QUEUE.DRAIN).toBe("loomail.drain");
  });

  it("REAP is loomail.reap", () => {
    expect(QUEUE.REAP).toBe("loomail.reap");
  });

  it("COUNTER_ROLLOVER is loomail.counter-rollover", () => {
    expect(QUEUE.COUNTER_ROLLOVER).toBe("loomail.counter-rollover");
  });

  it("PARTITION_MAINTENANCE is loomail.partition-maintenance", () => {
    expect(QUEUE.PARTITION_MAINTENANCE).toBe("loomail.partition-maintenance");
  });

  it("CONTENT_GENERATION is loomail.content-generation", () => {
    expect(QUEUE.CONTENT_GENERATION).toBe("loomail.content-generation");
  });

  it("KB_EMBED is loomail.kb-embed", () => {
    expect(QUEUE.KB_EMBED).toBe("loomail.kb-embed");
  });

  it("all queue names use the loomail. prefix", () => {
    for (const [key, value] of Object.entries(QUEUE)) {
      expect(value, `QUEUE.${key}`).toMatch(/^loomail\./);
    }
  });

  it("all queue names are unique", () => {
    const values = Object.values(QUEUE);
    expect(new Set(values).size).toBe(values.length);
  });

  it("QUEUE has exactly 14 entries (SCAN + COMPILE + TRIGGER_CHECK + DRAIN + REAP + COUNTER_ROLLOVER + PARTITION_MAINTENANCE + CONTENT_GENERATION + KB_EMBED + ADVANCE_MEMBERSHIP + PROCESS_MESSAGE + DRAIN_MESSAGE + GRID_SNAPSHOT + WEBHOOK_DELIVERY)", () => {
    expect(Object.keys(QUEUE)).toHaveLength(14);
  });

  it("QueueName is assignable from QUEUE values", () => {
    const names: QueueName[] = Object.values(QUEUE);
    expect(names).toHaveLength(14);
  });
});

describe("ScanJobData payload type", () => {
  it("ScanJobData is an empty-object shape", () => {
    const data: ScanJobData = {};
    expect(data).toEqual({});
  });
});

describe("CompileJobData payload type", () => {
  it("CompileJobData has flow_id and tenant_id", () => {
    const data: CompileJobData = {
      flow_id: "00000000-0000-0000-0000-000000000001",
      tenant_id: "00000000-0000-0000-0000-000000000002",
    };
    expect(data.flow_id).toBeDefined();
    expect(data.tenant_id).toBeDefined();
  });
});

describe("TriggerCheckJobData payload type", () => {
  it("TriggerCheckJobData has tenant_id, contact_id, and event_name", () => {
    const data: TriggerCheckJobData = {
      tenant_id: "00000000-0000-0000-0000-000000000001",
      contact_id: "00000000-0000-0000-0000-000000000002",
      event_name: "plan_upgraded",
    };
    expect(data.tenant_id).toBeDefined();
    expect(data.contact_id).toBeDefined();
    expect(data.event_name).toBeDefined();
  });
});

describe("DrainJobData payload type", () => {
  it("DrainJobData is an empty-object shape", () => {
    const data: DrainJobData = {};
    expect(data).toEqual({});
  });
});

describe("ReapJobData payload type", () => {
  it("ReapJobData is an empty-object shape", () => {
    const data: ReapJobData = {};
    expect(data).toEqual({});
  });
});

describe("CounterRolloverJobData payload type", () => {
  it("CounterRolloverJobData is an empty-object shape", () => {
    const data: CounterRolloverJobData = {};
    expect(data).toEqual({});
  });
});

describe("PartitionMaintenanceJobData payload type", () => {
  it("PartitionMaintenanceJobData is an empty-object shape", () => {
    const data: PartitionMaintenanceJobData = {};
    expect(data).toEqual({});
  });
});

describe("ContentGenerationJobData payload type", () => {
  it("ContentGenerationJobData is an empty-object shape", () => {
    const data: ContentGenerationJobData = {};
    expect(data).toEqual({});
  });
});

describe("KbEmbedJobData payload type", () => {
  it("KbEmbedJobData has kb_entry_id and tenant_id", () => {
    const data: KbEmbedJobData = {
      kb_entry_id: "00000000-0000-0000-0000-000000000001",
      tenant_id: "00000000-0000-0000-0000-000000000002",
    };
    expect(data.kb_entry_id).toBeDefined();
    expect(data.tenant_id).toBeDefined();
  });
});
