import type { Failure } from "./lifecycle.ts";

// Pure helpers for scripts/spike-authorize.ts: payee-rejection detection and the BUILD-LOG entry.

export type StepRecord = {
  label: string;
  call: string;
  ok: boolean;
  id?: string;
  status?: string;
  name?: string;
  issues?: string[];
  debugId?: string;
};

// PayPal's exact error names for a refused third-party payee are what R1 is finding out,
// so match on the words rather than a fixed list.
const PAYEE_PATTERN = /PAYEE|CONSENT|PERMISSION_DENIED/i;

export function isPayeeRejection(failure: Failure): boolean {
  return [failure.name ?? "", ...failure.issues].some((text) => PAYEE_PATTERN.test(text));
}

function describeStep(step: StepRecord): string {
  const head = `${step.label}.${step.call}`;
  if (step.ok) return `${head} → ${step.id ?? "?"} ${step.status ?? "?"}`;
  const why = [step.name, ...(step.issues ?? [])].filter(Boolean).join("/");
  return `${head} → FAILED ${step.status ?? "?"} ${why}${step.debugId ? ` (debug_id ${step.debugId})` : ""}`;
}

export type PayeeMode = "direct" | "coop_merchant";

const PAYEE_TEXT: Record<PayeeMode, { payee: string; prompt: string }> = {
  direct: {
    payee: "payee = supplier email",
    prompt:
      "\"Spike 1: create an order with intent AUTHORIZE and payee = SUPPLIER_SANDBOX_EMAIL, approve with the sandbox buyer, then partial capture, void a second, reauthorize a third. Stop and report if third-party payee is rejected.\"",
  },
  coop_merchant: {
    payee: "PAYEE_MODE=coop_merchant (no payee: the co-op app's own account is the merchant)",
    prompt:
      "\"Switch to PAYEE_MODE=coop_merchant: rerun the spike with no payee (capture, void, reauthorize) to confirm the fallback, and record the decision in DECISIONS.md.\"",
  },
};

export function formatBuildLogEntry(args: {
  date: string;
  payeeMode: PayeeMode;
  steps: StepRecord[];
  stoppedReason?: string;
}): string {
  const { payee, prompt } = PAYEE_TEXT[args.payeeMode];
  const what = `S1.1 R1 live run of scripts/spike-authorize.ts (APIMatic SDK \`paypal\`): 3 wallet-funded AUTHORIZE orders, ${payee}, approved by a sandbox buyer; A partial capture 60% final, B void, C reauthorize.`;
  const stopped = args.stoppedReason ? `STOPPED: ${args.stoppedReason}. ` : "";
  const outcome = `${stopped}${args.steps.map(describeStep).join("; ")}`;
  return `- ${args.date} · **What:** ${what}\n- **Prompt:** ${prompt}\n- **Outcome:** ${outcome}\n`;
}
