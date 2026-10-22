import { defineConfig } from "vitest/config";

// Live LLM evals. Opt-in: `pnpm test:llm`. Reads .env if present.
export default defineConfig({
  test: {
    include: ["test/llm/**/*.llm.test.ts"],
    setupFiles: ["test/load-env-file.ts"],
    testTimeout: 120_000,
    passWithNoTests: true,
  },
});
