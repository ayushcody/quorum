import { defineConfig } from "vitest/config";

// Default tier: no network. Live PayPal and live LLM tests have their own configs.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "web/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.sandbox.test.ts", "**/*.llm.test.ts"],
  },
});
