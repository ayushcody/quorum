import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadCoordinatorEnv } from "../../src/config/env.ts";
import { requestIdFor } from "../../src/outbox/request-id.ts";
import { createPayPalClient } from "../../src/paypal/client.ts";
import { ordersHandlers } from "../../src/paypal/orders.ts";
import { paymentsHandlers } from "../../src/paypal/payments.ts";
import { composePort, type PortRequest } from "../../src/paypal/port.ts";
import { loadSandboxCard } from "../../spikes/r2/card.ts";

// S2.4 (docs/PLAN.md): PayPal-Request-Id really dedupes a capture. The same capture sent twice with
// one Request-Id returns the same capture id and moves money once. Live sandbox, opt-in.
// Demo card per DECISIONS D4; no payee per D1.

describe("PayPal-Request-Id on a real capture", () => {
  const env = loadCoordinatorEnv();
  const card = loadSandboxCard(process.env);
  const client = createPayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET });
  const port = composePort(ordersHandlers(client, { cardSource: () => card }), paymentsHandlers(client));
  const run = randomUUID();

  it("returns the same capture id for the same Request-Id, and captures once", async () => {
    const order = await port.send({
      kind: "create_order",
      requestId: requestIdFor(`sandbox:${run}:order`),
      params: { amountCents: "1000", customId: `sandbox-${run}`, invoiceId: `sandbox-${run}`, funding: "demo_card" },
    } as PortRequest);
    expect(order.ok, JSON.stringify(order)).toBe(true);
    const authorizationId = (order as { body: { purchaseUnits: { payments: { authorizations: { id: string }[] } }[] } }).body.purchaseUnits[0]!.payments.authorizations[0]!.id;
    expect(authorizationId).toBeTruthy();

    const capture = { kind: "capture", requestId: requestIdFor(`sandbox:${run}:capture`), params: { authorizationId, amountCents: "600" } } as PortRequest;
    const first = await port.send(capture);
    const second = await port.send(capture);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    const firstId = (first as { body: { id: string } }).body.id;
    expect(firstId).toBeTruthy();
    expect((second as { body: { id: string } }).body.id).toBe(firstId);

    const authorization = await port.send({ kind: "get_authorization", requestId: requestIdFor(`sandbox:${run}:get`), params: { authorizationId } } as PortRequest);
    expect(authorization.ok, JSON.stringify(authorization)).toBe(true);
    expect((authorization as { body: { status: string } }).body.status).toMatch(/^(CAPTURED|PARTIALLY_CAPTURED)$/);

    // Contrast: a fresh Request-Id is a new capture attempt, and PayPal refuses it.
    const fresh = await port.send({ ...capture, requestId: requestIdFor(`sandbox:${run}:capture-again`) } as PortRequest);
    expect(fresh.ok, JSON.stringify(fresh)).toBe(false);
    const f = fresh as { httpStatus: number | null; name?: string; issues: string[] };
    console.log("request-id evidence:", JSON.stringify({ orderId: (order as { body: { id: string } }).body.id, authorizationId, captureId: firstId, authorizationStatus: (authorization as { body: { status: string } }).body.status, freshRequestId: { httpStatus: f.httpStatus, name: f.name, issues: f.issues } }));
  }, 90_000);
});
