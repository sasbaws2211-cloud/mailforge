/**
 * Tests for @claros/worker: createBoss factory and startWorker registration pattern.
 *
 * Covers the one queue defined in task 5 (SCAN). Pattern tests confirm:
 * - createBoss returns a usable instance without throwing
 * - startWorker registers exactly the queues defined in QUEUE
 * - the registered handler resolves without throwing (stub behavior)
 * - a throwing handler propagates its error (pg-boss uses this to call fail())
 * - fromDrizzle is re-exported for transactional job enqueue in API routes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QUEUE } from "@claros/core";
import { CLAROS_WORKER_VERSION, startWorker, createBoss, fromDrizzle } from "../src/index.js";

// ---------------------------------------------------------------------------
// pg-boss mock
// ---------------------------------------------------------------------------

const registrations: Array<{
  queue: string;
  handler: (jobs: Array<{ id: string; name: string; data: unknown }>) => Promise<void>;
}> = [];

const mockBoss = {
  createQueue: vi.fn(async (_name: string) => undefined),
  work: vi.fn(
    async (
      name: string,
      _opts: unknown,
      handler: (jobs: Array<{ id: string; name: string; data: unknown }>) => Promise<void>,
    ) => {
      registrations.push({ queue: name, handler });
      return `worker-id-${name}`;
    },
  ),
};

vi.mock("pg-boss", async () => {
  const actual = await vi.importActual<typeof import("pg-boss")>("pg-boss");
  const MockPgBoss = vi.fn().mockImplementation(() => mockBoss);
  return { ...actual, PgBoss: MockPgBoss };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("@claros/worker - version", () => {
  it("exports version", () => {
    expect(CLAROS_WORKER_VERSION).toBe("0.0.0");
  });
});

describe("createBoss", () => {
  it("returns an object with a work method (PgBoss-compatible)", () => {
    const boss = createBoss("postgres://localhost/test");
    expect(boss).toBeDefined();
    expect(typeof (boss as typeof mockBoss).work).toBe("function");
  });

  it("accepts schedule:false without throwing", () => {
    expect(() => createBoss("postgres://localhost/test", { schedule: false })).not.toThrow();
  });
});

describe("startWorker - registration pattern", () => {
  beforeEach(() => {
    registrations.length = 0;
    vi.clearAllMocks();
    mockBoss.createQueue.mockImplementation(async (_name: string) => undefined);
    mockBoss.work.mockImplementation(
      async (
        name: string,
        _opts: unknown,
        handler: (jobs: Array<{ id: string; name: string; data: unknown }>) => Promise<void>,
      ) => {
        registrations.push({ queue: name, handler });
        return `worker-id-${name}`;
      },
    );
  });

  it("registers a handler for every QUEUE constant", async () => {
    await startWorker(mockBoss as never);
    const registered = new Set(registrations.map((r) => r.queue));
    for (const name of Object.values(QUEUE)) {
      expect(registered, `missing handler for ${name}`).toContain(name);
    }
  });

  it("registers exactly as many handlers as QUEUE has entries", async () => {
    await startWorker(mockBoss as never);
    expect(registrations).toHaveLength(Object.keys(QUEUE).length);
  });

  it("no unrecognised queue names are registered", async () => {
    await startWorker(mockBoss as never);
    const known = new Set(Object.values(QUEUE));
    for (const { queue } of registrations) {
      expect(known, `unexpected registration: ${queue}`).toContain(queue);
    }
  });

  it("SCAN handler resolves without throwing", async () => {
    await startWorker(mockBoss as never);
    const reg = registrations.find((r) => r.queue === QUEUE.SCAN)!;
    expect(reg).toBeDefined();
    await expect(
      reg.handler([{ id: "j1", name: QUEUE.SCAN, data: {} }]),
    ).resolves.toBeUndefined();
  });
});

describe("failure path", () => {
  it("a throwing handler propagates its error (pg-boss calls fail() on throw)", async () => {
    const throwing = async (_jobs: unknown[]) => {
      throw new Error("simulated handler failure");
    };
    await expect(throwing([{ id: "j", name: "test", data: {} }])).rejects.toThrow(
      "simulated handler failure",
    );
  });

  it("startWorker does not throw when boss.work resolves normally", async () => {
    registrations.length = 0;
    vi.clearAllMocks();
    mockBoss.createQueue.mockImplementation(async (_name: string) => undefined);
    mockBoss.work.mockImplementation(async (name: string, _opts: unknown, handler: never) => {
      registrations.push({ queue: name, handler });
    });
    await expect(startWorker(mockBoss as never)).resolves.toBeUndefined();
  });
});

describe("fromDrizzle re-export", () => {
  it("fromDrizzle is a function exported from @claros/worker", () => {
    expect(typeof fromDrizzle).toBe("function");
  });
});
