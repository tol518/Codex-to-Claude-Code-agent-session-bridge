import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests mutate process.env (CODEX_HOME etc.); run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
