import { describe, expect, it } from "vitest";
import { formatBuildLogEntry, isPayeeRejection, type StepRecord } from "../../spikes/r1/report.ts";

describe("isPayeeRejection", () => {
  it("flags failures whose name or issues mention the payee or missing consent", () => {
    expect(isPayeeRejection({ ok: false, status: 422, name: "UNPROCESSABLE_ENTITY", issues: ["PAYEE_ACCOUNT_INVALID"] })).toBe(true);
    expect(isPayeeRejection({ ok: false, status: 403, name: "NOT_AUTHORIZED", issues: ["PERMISSION_DENIED"] })).toBe(true);
    expect(isPayeeRejection({ ok: false, status: 422, issues: ["PAYEE_NOT_CONSENTED"] })).toBe(true);
  });

  it("does not flag unrelated failures", () => {
    expect(isPayeeRejection({ ok: false, status: 422, name: "UNPROCESSABLE_ENTITY", issues: ["ORDER_NOT_APPROVED"] })).toBe(false);
    expect(isPayeeRejection({ ok: false, status: 500, issues: [] })).toBe(false);
  });
});

describe("formatBuildLogEntry", () => {
  const steps: StepRecord[] = [
    { label: "A", call: "createOrder", ok: true, status: "PAYER_ACTION_REQUIRED", id: "ORD-A" },
    { label: "A", call: "captureAuthorizedPayment", ok: true, status: "COMPLETED", id: "CAP-1" },
    { label: "C", call: "reauthorizePayment", ok: false, status: "422", name: "UNPROCESSABLE_ENTITY", issues: ["REAUTHORIZATION_TOO_SOON"] },
  ];

  it("writes exactly three lines: what, prompt, outcome", () => {
    const entry = formatBuildLogEntry({ date: "2026-10-22", payeeMode: "direct", steps });
    const lines = entry.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^- 2026-10-22 · \*\*What:\*\*/);
    expect(lines[1]).toMatch(/^- \*\*Prompt:\*\*/);
    expect(lines[2]).toMatch(/^- \*\*Outcome:\*\*/);
  });

  it("lists every response id and status, and failure names", () => {
    const outcome = formatBuildLogEntry({ date: "2026-10-22", payeeMode: "direct", steps }).split("\n")[2]!;
    expect(outcome).toContain("ORD-A PAYER_ACTION_REQUIRED");
    expect(outcome).toContain("CAP-1 COMPLETED");
    expect(outcome).toContain("REAUTHORIZATION_TOO_SOON");
  });

  it("says plainly when the run stopped on a payee rejection", () => {
    const outcome = formatBuildLogEntry({ date: "2026-10-22", payeeMode: "direct", steps, stoppedReason: "third-party payee rejected" }).split("\n")[2]!;
    expect(outcome).toMatch(/STOPPED: third-party payee rejected/);
  });

  it("names the payee mode in the What line", () => {
    const direct = formatBuildLogEntry({ date: "2026-10-22", payeeMode: "direct", steps }).split("\n")[0]!;
    const coop = formatBuildLogEntry({ date: "2026-10-22", payeeMode: "coop_merchant", steps }).split("\n")[0]!;
    expect(direct).toContain("payee = supplier email");
    expect(coop).toContain("PAYEE_MODE=coop_merchant");
    expect(coop).toContain("no payee");
    expect(coop).not.toContain("payee = supplier email");
  });
});
