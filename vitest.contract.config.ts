import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/contract/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
