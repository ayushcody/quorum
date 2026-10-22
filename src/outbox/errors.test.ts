import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PortOutcome } from "../paypal/port.ts";
import { classify } from "./errors.ts";
import { OP_KINDS, type OpKind } from "./kinds.ts";

const OBSERVABLE: OpKind[] = ["capture", "void", "authorize_order", "refund"];
const OTHER_WRITES: OpKind[] = ["create_order", "reauthorize", "payout"];
const READS: OpKind[] = OP_KINDS.filter((k) => ![...OBSERVABLE, ...OTHER_WRITES].includes(k));

const ok: PortOutcome = { ok: true, httpStatus: 201, body: {} };
const http = (httpStatus: number, name?: string, issues: string[] = []): PortOutcome => ({ ok: false, httpStatus, transport: null, name, issues });
const transport = (t: "timeout" | "network" | "config"): PortOutcome => ({ ok: false, httpStatus: null, transport: t, issues: [] });

describe("classify", () => {
  it("treats any ok outcome as succeeded", () => {
    for (const kind of OP_KINDS) expect(classify(kind, ok), kind).toBe("succeeded");
  });

  it("treats config failures (bad credentials, unsupported kind) as terminal", () => {
    for (const kind of OP_KINDS) expect(classify(kind, transport("config")), kind).toBe("terminal");
  });

  it("treats 401, 403 and 415 as terminal configuration problems, never retried", () => {
    for (const kind of OP_KINDS) for (const status of [401, 403, 415]) expect(classify(kind, http(status)), `${kind} ${status}`).toBe("terminal");
  });

  it("counts a payout 'sender_batch_id already exists' as succeeded (DECISIONS D1)", () => {
    const dup = http(400, "USER_BUSINESS_ERROR", ["Batch with given sender_batch_id already exists"]);
    expect(classify("payout", dup)).toBe("succeeded");
    expect(classify("payout", http(400, "USER_BUSINESS_ERROR", ["SENDER_BATCH_ID ALREADY EXISTS"]))).toBe("succeeded");
  });

  it("does not stretch the payout duplicate rule to other errors or other kinds", () => {
    expect(classify("payout", http(400, "USER_BUSINESS_ERROR", ["Insufficient funds"]))).toBe("terminal");
    expect(classify("payout", http(400, "VALIDATION_ERROR", ["sender_batch_id already exists"]))).toBe("terminal");
    expect(classify("capture", http(400, "USER_BUSINESS_ERROR", ["sender_batch_id already exists"]))).toBe("terminal");
  });

  it("checks the resource before retrying an observable write that timed out, errored on the network, or got a 5xx", () => {
    for (const kind of OBSERVABLE) {
      expect(classify(kind, transport("timeout")), kind).toBe("check_then_retry");
      expect(classify(kind, transport("network")), kind).toBe("check_then_retry");
      for (const status of [500, 502, 503, 504]) expect(classify(kind, http(status)), `${kind} ${status}`).toBe("check_then_retry");
    }
  });

  it("resends other writes and reads after a timeout, network error or 5xx (the deterministic id makes it safe)", () => {
    for (const kind of [...OTHER_WRITES, ...READS]) {
      expect(classify(kind, transport("timeout")), kind).toBe("retry_later");
      expect(classify(kind, transport("network")), kind).toBe("retry_later");
      expect(classify(kind, http(500)), kind).toBe("retry_later");
      expect(classify(kind, http(503)), kind).toBe("retry_later");
    }
  });

  it("retries 429 later for every kind, with no GET first", () => {
    for (const kind of OP_KINDS) expect(classify(kind, http(429, "RATE_LIMIT_REACHED")), kind).toBe("retry_later");
  });

  it("lets a GET decide after 409 or 422 on an observable write (already captured? or really refused?)", () => {
    for (const kind of OBSERVABLE) {
      expect(classify(kind, http(422, "UNPROCESSABLE_ENTITY", ["AUTHORIZATION_ALREADY_CAPTURED"])), kind).toBe("check_then_terminal");
      expect(classify(kind, http(409, "RESOURCE_CONFLICT")), kind).toBe("check_then_terminal");
    }
  });

  it("makes REAUTHORIZATION_TOO_SOON terminal rather than something a GET could settle", () => {
    expect(classify("reauthorize", http(422, "UNPROCESSABLE_ENTITY", ["REAUTHORIZATION_TOO_SOON"]))).toBe("terminal");
  });

  it("makes every other 4xx terminal", () => {
    expect(classify("create_order", http(422, "UNPROCESSABLE_ENTITY"))).toBe("terminal");
    expect(classify("capture", http(400, "INVALID_REQUEST"))).toBe("terminal");
    expect(classify("get_authorization", http(404, "RESOURCE_NOT_FOUND"))).toBe("terminal");
    expect(classify("void", http(404, "RESOURCE_NOT_FOUND"))).toBe("terminal");
  });

  it("never reports succeeded for a failure, except the payout duplicate (property)", () => {
    const failure = fc.oneof(
      fc.integer({ min: 400, max: 599 }).map((s) => http(s)),
      fc.constantFrom<"timeout" | "network" | "config">("timeout", "network", "config").map(transport),
    );
    fc.assert(
      fc.property(fc.constantFrom(...OP_KINDS), failure, (kind, outcome) => {
        expect(classify(kind, outcome)).not.toBe("succeeded");
      }),
    );
  });

  it("is a pure function of kind and outcome, and sends every 5xx on an observable write to a GET first (property)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...OBSERVABLE), fc.integer({ min: 500, max: 599 }), (kind, status) => {
        const outcome = http(status);
        expect(classify(kind, outcome)).toBe(classify(kind, outcome));
        expect(classify(kind, outcome)).toBe("check_then_retry");
      }),
    );
  });
});
