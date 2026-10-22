import { describe, expect, it } from "vitest";
import { checkBoundaries, collectSourceFiles } from "./boundaries.ts";

// Rules live in boundaries.ts and mirror docs/ARCHITECTURE.md §2.
describe("module boundaries", () => {
  it("the real tree has no violations", () => {
    const violations = checkBoundaries(collectSourceFiles(["src", "web", "scripts"]));
    expect(violations).toEqual([]);
  });

  const cases: Array<{ rule: string; path: string; source: string }> = [
    { rule: "policy-pure", path: "src/policy/clearing.ts", source: `import { db } from "../db/client.ts";` },
    { rule: "policy-pure", path: "src/policy/clearing.ts", source: `import { z } from "zod";` },
    { rule: "policy-pure", path: "src/policy/clearing.ts", source: `import { readFileSync } from "node:fs";` },
    { rule: "sdk-only-in-client", path: "src/pledge/service.ts", source: `import { PaypalClient } from "paypal";` },
    { rule: "payments-only-in-worker", path: "src/settlement/planner.ts", source: `import { capture } from "../paypal/payments.ts";` },
    { rule: "payments-only-in-worker", path: "src/api/judge.ts", source: `export * from "../paypal/payments";` },
    { rule: "llm-no-money", path: "src/agents/intake.ts", source: `import { paypalCall } from "../paypal/call.ts";` },
    { rule: "llm-no-money", path: "src/negotiation/narrator.ts", source: `const m = await import("../settlement/worker.ts");` },
    { rule: "toolkit-only-in-fulfillment", path: "src/supplier/narrator.ts", source: `import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";` },
    { rule: "supplier-isolated", path: "src/supplier/strategy.ts", source: `import { allocate } from "../policy/allocate.ts";` },
    { rule: "supplier-isolated", path: "src/negotiation/orchestrator.ts", source: `import { floor } from "../supplier/strategy.ts";` },
    { rule: "ai-only-in-llm-files", path: "src/settlement/planner.ts", source: `import { generateText } from "ai";` },
    { rule: "ai-only-in-llm-files", path: "src/api/app.ts", source: `import { anthropic } from "@ai-sdk/anthropic";` },
  ];

  it.each(cases)("$rule catches $path", ({ rule, path, source }) => {
    const violations = checkBoundaries([{ path, source }]);
    expect(violations.map((v) => v.rule)).toContain(rule);
  });

  const allowed: Array<{ path: string; source: string }> = [
    { path: "src/policy/clearing.ts", source: `import { add } from "./money.ts";` },
    { path: "src/paypal/client.ts", source: `import { PaypalClient } from "paypal";` },
    { path: "src/settlement/worker.ts", source: `import { capture } from "../paypal/payments.ts";` },
    { path: "src/supplier/fulfillment.ts", source: `import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";\nimport { generateText } from "ai";` },
    { path: "src/supplier/main.ts", source: `import { offerSchema } from "../protocol/messages.ts";\nimport { Hono } from "hono";` },
    { path: "src/agents/intake.ts", source: `import { generateObject } from "ai";\nimport { mandateSchema } from "../policy/mandate.ts";` },
  ];

  it.each(allowed)("allows $path", ({ path, source }) => {
    expect(checkBoundaries([{ path, source }])).toEqual([]);
  });
});
