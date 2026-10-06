import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Files that share a database lock wait their turn in beforeAll.
    hookTimeout: 120_000,
    // Keep tests independent of the developer's local environment.
    setupFiles: ["./tests/setup-env.ts"],
  },
});
