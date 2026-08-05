/**
 * Alias resolution smoke test.
 *
 * Verifies that the "@/*" path alias resolves in the vitest runner.
 * If the alias is misconfigured, vitest will fail to resolve "@/lib/utils"
 * with a module-not-found error.
 *
 * This test has lasting value: it is the cheapest guard against alias
 * regressions when vite.config.ts is edited in the future. Kept.
 */
import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("@/ alias resolution", () => {
  it("resolves @/lib/utils and cn() merges class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("cn() deduplicates conflicting Tailwind classes (tailwind-merge)", () => {
    // tailwind-merge keeps the last of two conflicting classes
    expect(cn("bg-red-500", "bg-blue-500")).toBe("bg-blue-500");
  });
});
