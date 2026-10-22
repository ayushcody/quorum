import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { observedDone, reconcileRead } from "./reconcile.ts";

// Bodies are the SDK's camelCase shapes, as FakePayPal and the real handlers return them.
describe("observedDone", () => {
  it("capture: done when the authorization is CAPTURED or PARTIALLY_CAPTURED", () => {
    expect(observedDone("capture", { id: "A", status: "CAPTURED" })).toBe(true);
    expect(observedDone("capture", { id: "A", status: "PARTIALLY_CAPTURED" })).toBe(true);
    expect(observedDone("capture", { id: "A", status: "CREATED" })).toBe(false);
    expect(observedDone("capture", { id: "A", status: "VOIDED" })).toBe(false);
  });

  it("void: done only when the authorization is VOIDED", () => {
    expect(observedDone("void", { id: "A", status: "VOIDED" })).toBe(true);
    expect(observedDone("void", { id: "A", status: "CREATED" })).toBe(false);
    expect(observedDone("void", { id: "A", status: "CAPTURED" })).toBe(false);
  });

  it("authorize_order: done when the order has an authorization on its first purchase unit", () => {
    const authorized = { id: "O", status: "COMPLETED", purchaseUnits: [{ payments: { authorizations: [{ id: "AUTH-1", status: "CREATED" }] } }] };
    expect(observedDone("authorize_order", authorized)).toBe(true);
    expect(observedDone("authorize_order", { id: "O", status: "APPROVED", purchaseUnits: [{}] })).toBe(false);
    expect(observedDone("authorize_order", { id: "O", purchaseUnits: [{ payments: { authorizations: [] } }] })).toBe(false);
    expect(observedDone("authorize_order", { id: "O", purchaseUnits: [] })).toBe(false);
  });

  it("refund: done when the capture is REFUNDED or PARTIALLY_REFUNDED", () => {
    expect(observedDone("refund", { id: "C", status: "REFUNDED" })).toBe(true);
    expect(observedDone("refund", { id: "C", status: "PARTIALLY_REFUNDED" })).toBe(true);
    expect(observedDone("refund", { id: "C", status: "COMPLETED" })).toBe(false);
  });

  it("is false, not a throw, for bodies it cannot read (property)", () => {
    fc.assert(
      fc.property(fc.constantFrom("capture", "void", "authorize_order", "refund"), fc.anything(), (kind, body) => {
        expect(observedDone(kind, body)).toBe(false);
      }),
    );
    for (const kind of ["capture", "void", "authorize_order", "refund"] as const) {
      expect(observedDone(kind, null)).toBe(false);
      expect(observedDone(kind, undefined)).toBe(false);
    }
  });
});

describe("reconcileRead", () => {
  it("reads the resource each write targets", () => {
    expect(reconcileRead("capture", { authorizationId: "AUTH-1", amountCents: "1000" })).toEqual({ kind: "get_authorization", params: { authorizationId: "AUTH-1" } });
    expect(reconcileRead("void", { authorizationId: "AUTH-2" })).toEqual({ kind: "get_authorization", params: { authorizationId: "AUTH-2" } });
    expect(reconcileRead("authorize_order", { orderId: "ORDER-1" })).toEqual({ kind: "get_order", params: { orderId: "ORDER-1" } });
    expect(reconcileRead("refund", { captureId: "CAP-1", amountCents: "500" })).toEqual({ kind: "get_capture", params: { captureId: "CAP-1" } });
  });
});
