import { describe, expect, it, vi } from "vitest";
import { publicKey, rawBody, signedHeaders, WEBHOOK_ID } from "../../test/fixtures/webhook-signing.ts";
import { createApp, type AppDeps } from "./app.ts";

function deps(overrides: Partial<AppDeps> = {}): AppDeps & { log: ReturnType<typeof vi.fn> } {
  return { webhookId: WEBHOOK_ID, getPublicKey: async () => publicKey, log: vi.fn(), ...overrides } as AppDeps & { log: ReturnType<typeof vi.fn> };
}

describe("GET /health", () => {
  it("is 200 with the database unconfigured", async () => {
    const res = await createApp(deps()).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", db: "unconfigured" });
  });

  it("is 200 when the database answers and 503 when it does not", async () => {
    const up = await createApp(deps({ pingDb: async () => {} })).request("/health");
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({ db: "ok" });
    const down = await createApp(deps({ pingDb: async () => Promise.reject(new Error("ECONNREFUSED")) })).request("/health");
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ status: "degraded", db: "down" });
  });
});

describe("POST /webhooks/paypal", () => {
  const post = (app: ReturnType<typeof createApp>, body: string, headers: Record<string, string>) =>
    app.request("/webhooks/paypal", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

  it("verifies against the raw body, logs ids only, and returns 200", async () => {
    const d = deps();
    const res = await post(createApp(d), rawBody, signedHeaders(rawBody));
    expect(res.status).toBe(200);
    expect(d.log).toHaveBeenCalledWith("paypal_webhook", {
      verified: true,
      eventId: "WH-EVT-1",
      eventType: "PAYMENT.AUTHORIZATION.CREATED",
      resourceId: "AUTH-1",
      transmissionId: "tx-1",
    });
  });

  it("returns 400 and logs the reason for a bad signature", async () => {
    const d = deps();
    const res = await post(createApp(d), rawBody.replace("AUTH-1", "AUTH-2"), signedHeaders(rawBody));
    expect(res.status).toBe(400);
    expect(d.log).toHaveBeenCalledWith("paypal_webhook_rejected", expect.objectContaining({ reason: "bad_signature", transmissionId: "tx-1" }));
  });

  it("returns 503 until PAYPAL_WEBHOOK_ID is configured, so PayPal retries", async () => {
    const res = await post(createApp(deps({ webhookId: undefined })), rawBody, signedHeaders(rawBody));
    expect(res.status).toBe(503);
  });
});
