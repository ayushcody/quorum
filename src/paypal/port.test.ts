import { describe, expect, it } from "vitest";
import type { OpKind } from "../outbox/kinds.ts";
import { composePort, type PortOutcome, type PortRequest } from "./port.ts";

const req = (kind: OpKind, params: object = {}): PortRequest => ({ kind, requestId: "11111111-1111-5111-8111-111111111111", params }) as PortRequest;
const okBody = (body: unknown): PortOutcome => ({ ok: true, httpStatus: 200, body });

describe("composePort", () => {
  it("routes a request to the handler for its kind, across handler sets", async () => {
    const port = composePort(
      { get_order: async () => okBody("order") },
      { capture: async (r) => okBody(`captured ${r.requestId}`) },
    );
    expect(await port.send(req("get_order"))).toEqual(okBody("order"));
    expect(await port.send(req("capture"))).toEqual(okBody("captured 11111111-1111-5111-8111-111111111111"));
  });

  it("reports an unsupported kind as a config failure, not a throw", async () => {
    const port = composePort({ get_order: async () => okBody("order") });
    expect(await port.send(req("payout"))).toEqual({ ok: false, httpStatus: null, transport: "config", name: "UNSUPPORTED_KIND", issues: [] });
  });
});
