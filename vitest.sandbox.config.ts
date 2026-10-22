import { defineConfig } from "vitest/config";

// Live PayPal sandbox tests. Opt-in: `pnpm test:sandbox`. Reads .env if present.
export default defineConfig({
  test: {
    include: ["test/sandbox/**/*.sandbox.test.ts"],
    setupFiles: ["test/load-env-file.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
