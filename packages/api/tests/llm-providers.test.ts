import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyLlmCredentials } from "../src/llm-providers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LLM credential verification", () => {
  it("does not impose a timeout on provider verification", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await expect(
      verifyLlmCredentials({ baseUrl: "https://provider.example/v1", apiKey: "key", model: "model" }),
    ).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("signal");
  });
});
