import { afterEach, describe, expect, it, vi } from "vitest";
import { VERIFY_TIMEOUT_MS, verifyLlmCredentials } from "../src/llm-providers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LLM credential verification", () => {
  it("aborts provider verification after 10 seconds", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await expect(
      verifyLlmCredentials({ baseUrl: "https://provider.example/v1", apiKey: "key", model: "model" }),
    ).resolves.toEqual({ ok: true });

    expect(VERIFY_TIMEOUT_MS).toBe(10_000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
