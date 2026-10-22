import { describe, expect, it } from "vitest";
import { createPayPalClient } from "./client.ts";
import { ordersHandlers } from "./orders.ts";
import { paymentsHandlers } from "./payments.ts";
import type { PortRequest } from "./port.ts";

// Stubs ClientOptions.fetch and answers with wire-shape (snake_case) JSON, as PayPal sends it.
type Seen = { url: URL; method: string; headers: Headers; body: string };

function stubPayPal(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const entry: Seen = { url: new URL(request.url), method: request.method, headers: request.headers, body: await request.text() };
    seen.push(entry);
    if (entry.url.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21-test-token", token_type: "Bearer", expires_in: 32400 });
    return respond(entry);
  };
  const client = createPayPalClient({ clientId: "client-id", clientSecret: "client-secret", fetch: fetchStub });
  const api = () => seen.filter((s) => s.url.pathname !== "/v1/oauth2/token");
  return { client, seen, api };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const REQUEST_ID = "6f1c2c4e-9a53-5b1e-8f0e-2d6f3b7a9c10";
const send = <K extends PortRequest["kind"]>(kind: K, params: object): PortRequest => ({ kind, requestId: REQUEST_ID, params }) as PortRequest;

describe("PayPal client over a stubbed fetch", () => {
  it("sends authorize_order with Content-Type and PayPal-Request-Id even though the call has no body (DECISIONS D3)", async () => {
    const { client, api } = stubPayPal(() =>
      json(201, {
        id: "ORDER-1",
        status: "COMPLETED",
        purchase_units: [{ reference_id: "default", payments: { authorizations: [{ id: "AUTH-1", status: "CREATED", amount: { currency_code: "USD", value: "10.00" } }] } }],
      }),
    );
    const outcome = await ordersHandlers(client, {}).authorize_order!(send("authorize_order", { orderId: "ORDER-1" }));

    expect(outcome.ok).toBe(true);
    const [call] = api();
    expect(call!.method).toBe("POST");
    expect(call!.url.pathname).toBe("/v2/checkout/orders/ORDER-1/authorize");
    expect(call!.headers.get("content-type")).toContain("application/json");
    expect(call!.headers.get("paypal-request-id")).toBe(REQUEST_ID);
    expect(call!.headers.get("authorization")).toBe("Bearer A21-test-token");
  });

  it("sends void (always body-less) with Content-Type and PayPal-Request-Id", async () => {
    const { client, api } = stubPayPal(() => new Response(null, { status: 204 }));
    const outcome = await paymentsHandlers(client).void!(send("void", { authorizationId: "AUTH-1" }));

    expect(outcome).toMatchObject({ ok: true, httpStatus: 204 });
    const [call] = api();
    expect(call!.method).toBe("POST");
    expect(call!.url.pathname).toBe("/v2/payments/authorizations/AUTH-1/void");
    expect(call!.headers.get("content-type")).toContain("application/json");
    expect(call!.headers.get("paypal-request-id")).toBe(REQUEST_ID);
  });

  it("captures the exact cents as a decimal string, as a final capture, under the request id", async () => {
    const { client, api } = stubPayPal(() => json(201, { id: "CAP-1", status: "COMPLETED", amount: { currency_code: "USD", value: "6.05" }, final_capture: true }));
    const outcome = await paymentsHandlers(client).capture!(send("capture", { authorizationId: "AUTH-1", amountCents: "605" }));

    expect(outcome).toMatchObject({ ok: true, httpStatus: 201, body: { id: "CAP-1", status: "COMPLETED" } });
    const [call] = api();
    expect(call!.url.pathname).toBe("/v2/payments/authorizations/AUTH-1/capture");
    expect(call!.headers.get("paypal-request-id")).toBe(REQUEST_ID);
    const body = JSON.parse(call!.body);
    expect(body.final_capture).toBe(true);
    expect(body.amount).toEqual({ currency_code: "USD", value: "6.05" });
  });

  it("turns a typed PayPal error into a PortOutcome with name, issues and debug id", async () => {
    const { client } = stubPayPal(() =>
      json(422, { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed.", debug_id: "dbg-123", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED", description: "Authorization has already been captured." }] }),
    );
    const outcome = await paymentsHandlers(client).capture!(send("capture", { authorizationId: "AUTH-1", amountCents: "1000" }));

    expect(outcome).toMatchObject({ ok: false, httpStatus: 422, transport: null, name: "UNPROCESSABLE_ENTITY", issues: ["AUTHORIZATION_ALREADY_CAPTURED"], debugId: "dbg-123" });
  });

  it("does not retry inside the SDK: one 503 means one request (the outbox owns retries)", async () => {
    const { client, api } = stubPayPal(() => json(503, { name: "SERVICE_UNAVAILABLE", message: "down", debug_id: "dbg-503" }));
    const outcome = await paymentsHandlers(client).get_authorization!(send("get_authorization", { authorizationId: "AUTH-1" }));

    expect(outcome).toMatchObject({ ok: false, httpStatus: 503 });
    expect(api()).toHaveLength(1);
  });

  it("refuses a demo_card order when no card source was injected, and sends nothing", async () => {
    const { client, api } = stubPayPal(() => json(201, { id: "ORDER-X", status: "CREATED" }));
    const outcome = await ordersHandlers(client, {}).create_order!(send("create_order", { amountCents: "1000", customId: "h", invoiceId: "inv-1", funding: "demo_card" }));

    expect(outcome).toMatchObject({ ok: false, transport: "config" });
    expect(api()).toHaveLength(0);
  });
});
