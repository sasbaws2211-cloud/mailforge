import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FailoverProvider,
  LlmProviderError,
  MeteredProvider,
  buildProviderFromCandidates,
  isFailoverError,
  type CompletionResult,
  type LlmProvider,
  type ProviderCandidate,
} from "../src/index.js";

const opts = { messages: [{ role: "user" as const, content: "hello there" }] };

const answering = (content: string, usage?: CompletionResult["usage"]): LlmProvider => ({
  complete: async () => ({ content, ...(usage ? { usage } : {}) }),
});
const failing = (status: number | null, retryable = false): LlmProvider => ({
  complete: async () => {
    throw new LlmProviderError(`boom ${status}`, status, retryable);
  },
});

describe("MeteredProvider", () => {
  it("reports the usage the provider gives", async () => {
    const seen: unknown[] = [];
    const p = new MeteredProvider(answering("hi", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), (e) => {
      seen.push(e);
    });
    await p.complete(opts);
    expect(seen).toEqual([{ ok: true, promptTokens: 10, completionTokens: 5, totalTokens: 15 }]);
  });

  it("estimates when the provider stays silent, so an allowance cannot be dodged", async () => {
    const seen: Array<{ totalTokens: number; promptTokens: number; completionTokens: number }> = [];
    const p = new MeteredProvider(answering("x".repeat(40)), (e) => {
      seen.push(e);
    });
    await p.complete({ messages: [{ role: "user", content: "y".repeat(80) }] });
    expect(seen[0]).toMatchObject({ promptTokens: 20, completionTokens: 10, totalTokens: 30 });
  });

  it("reports a failed call with zero tokens and still throws the original error", async () => {
    const seen: Array<{ ok: boolean; totalTokens: number }> = [];
    const p = new MeteredProvider(failing(500), (e) => {
      seen.push(e);
    });
    await expect(p.complete(opts)).rejects.toThrow("boom 500");
    expect(seen).toEqual([{ ok: false, promptTokens: 0, completionTokens: 0, totalTokens: 0 }]);
  });

  it("never fails the call because metering failed", async () => {
    const p = new MeteredProvider(answering("fine"), () => {
      throw new Error("db down");
    });
    await expect(p.complete(opts)).resolves.toMatchObject({ content: "fine" });
    const q = new MeteredProvider(failing(500), async () => {
      throw new Error("db down");
    });
    await expect(q.complete(opts)).rejects.toThrow("boom 500");
  });
});

describe("isFailoverError", () => {
  it("fails over for the provider's or the key's fault, not for a bad request", () => {
    for (const s of [null, 429, 500, 502, 503, 401, 402, 403, 404]) {
      expect(isFailoverError(new LlmProviderError("x", s, false))).toBe(true);
    }
    expect(isFailoverError(new LlmProviderError("x", 400, false))).toBe(false);
    expect(isFailoverError(new LlmProviderError("x", 422, false))).toBe(false);
    expect(isFailoverError(new Error("unexpected"))).toBe(true);
  });
});

describe("FailoverProvider", () => {
  it("uses the first provider when it works and never touches the second", async () => {
    const second = vi.fn(async () => ({ content: "second" }));
    const p = new FailoverProvider([answering("first"), { complete: second }]);
    expect((await p.complete(opts)).content).toBe("first");
    expect(second).not.toHaveBeenCalled();
  });

  it("falls through to the next provider on an outage, a rate limit or a rejected key", async () => {
    for (const status of [null, 429, 503, 401, 402]) {
      const onFailover = vi.fn();
      const p = new FailoverProvider([failing(status), answering("backup")], onFailover);
      expect((await p.complete(opts)).content).toBe("backup");
      expect(onFailover).toHaveBeenCalledTimes(1);
      expect(onFailover.mock.calls[0]![0]).toBe(0);
    }
  });

  it("does not fail over on a 400: the request is wrong and a second provider would repeat it", async () => {
    const second = vi.fn(async () => ({ content: "second" }));
    const p = new FailoverProvider([failing(400), { complete: second }]);
    await expect(p.complete(opts)).rejects.toThrow("boom 400");
    expect(second).not.toHaveBeenCalled();
  });

  it("throws the last error when every provider fails", async () => {
    const p = new FailoverProvider([failing(500), failing(503)]);
    await expect(p.complete(opts)).rejects.toThrow("boom 503");
  });

  it("needs at least one provider", () => {
    expect(() => new FailoverProvider([])).toThrow();
  });
});

describe("buildProviderFromCandidates", () => {
  const cfg = (model: string) => JSON.stringify({ apiKey: "k", baseUrl: "http://127.0.0.1:1/v1", model });
  const own: ProviderCandidate = { source: "byok", slot: null, provider: "openai", config: "enc:own" };
  const primary: ProviderCandidate = { source: "platform", slot: "primary", provider: "openai", config: "enc:primary" };
  const fallback: ProviderCandidate = { source: "platform", slot: "fallback", provider: "anthropic", config: "enc:fallback" };
  const decrypt = (s: string) => {
    if (s === "enc:own") return cfg("own-model");
    if (s === "enc:primary") return cfg("primary-model");
    if (s === "enc:fallback") return cfg("fallback-model");
    throw new Error("bad envelope");
  };

  it("builds one provider for one candidate and reports its source", () => {
    const r = buildProviderFromCandidates([own], { decrypt });
    expect(r).toMatchObject({ ok: true, source: "byok", usable: 1 });
  });

  it("chains the operator's primary and fallback", () => {
    const r = buildProviderFromCandidates([primary, fallback], { decrypt });
    expect(r).toMatchObject({ ok: true, source: "platform", usable: 2 });
  });

  it("skips a candidate that cannot be decrypted and uses the rest", () => {
    const r = buildProviderFromCandidates([{ ...primary, config: "garbage" }, fallback], { decrypt });
    expect(r).toMatchObject({ ok: true, usable: 1 });
  });

  it("fails with the decrypt reason when nothing is usable (a broken own key says so)", () => {
    const r = buildProviderFromCandidates([{ ...own, config: "garbage" }], { decrypt });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("Failed to decrypt LLM configuration: bad envelope");
  });

  it("fails cleanly with no candidates", () => {
    const r = buildProviderFromCandidates([], { decrypt });
    expect(r.ok).toBe(false);
  });

  it("tags usage with who served the call", async () => {
    const calls: Array<{ source: string; slot: string | null; model: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const r = buildProviderFromCandidates([primary], {
        decrypt,
        onUsage: (meta) => {
          calls.push({ source: meta.source, slot: meta.slot, model: meta.model });
        },
      });
      if (!r.ok) throw new Error("expected ok");
      await r.provider.complete(opts);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual([{ source: "platform", slot: "primary", model: "primary-model" }]);
  });
});

afterEach(() => vi.restoreAllMocks());

describe("cost of a call", () => {
  const priced = JSON.stringify({ apiKey: "k", baseUrl: "http://127.0.0.1:1/v1", model: "m", input_price: 2, output_price: 10 });
  const run = async (source: "platform" | "byok", config: string) => {
    const seen: number[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const r = buildProviderFromCandidates([{ source, slot: source === "platform" ? "primary" : null, provider: "custom", config: "e" }], {
        decrypt: () => config,
        onUsage: (_m, e) => {
          seen.push(e.costMicros);
        },
      });
      if (!r.ok) throw new Error("expected ok");
      await r.provider.complete(opts);
    } finally {
      globalThis.fetch = realFetch;
    }
    return seen;
  };

  it("the operator's provider is priced from its configured prices (100 in x $2 + 50 out x $10 = 700 micro-dollars)", async () => {
    expect(await run("platform", priced)).toEqual([700]);
  });

  it("a provider with no prices set costs nothing on paper", async () => {
    expect(await run("platform", cfgNoPrice())).toEqual([0]);
  });

  it("a customer's own key never costs the operator anything, even with prices in its config", async () => {
    expect(await run("byok", priced)).toEqual([0]);
  });
});

function cfgNoPrice() {
  return JSON.stringify({ apiKey: "k", baseUrl: "http://127.0.0.1:1/v1", model: "m" });
}
