import { describe, expect, it, vi } from "vitest";
import { publicKey, rawBody, signedHeaders, WEBHOOK_ID } from "../../test/fixtures/webhook-signing.ts";
import { verifyWebhookSignature } from "./verify.ts";

const getPublicKey = vi.fn(async () => publicKey);

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed event", async () => {
    const result = await verifyWebhookSignature({ headers: signedHeaders(rawBody), rawBody, webhookId: WEBHOOK_ID, getPublicKey });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a body changed after signing (even whitespace)", async () => {
    const headers = signedHeaders(rawBody);
    const result = await verifyWebhookSignature({ headers, rawBody: `${rawBody} `, webhookId: WEBHOOK_ID, getPublicKey });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an event signed for a different webhook id", async () => {
    const result = await verifyWebhookSignature({ headers: signedHeaders(rawBody, "WH-OTHER"), rawBody, webhookId: WEBHOOK_ID, getPublicKey });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a cert URL outside PayPal's sandbox cert path, without fetching it", async () => {
    getPublicKey.mockClear();
    for (const url of ["https://evil.example/certs/x", "http://api.sandbox.paypal.com/v1/notifications/certs/x", "https://api.sandbox.paypal.com.evil.example/v1/notifications/certs/x", "https://api.paypal.com/v1/notifications/certs/x"]) {
      const result = await verifyWebhookSignature({ headers: signedHeaders(rawBody, WEBHOOK_ID, { "paypal-cert-url": url }), rawBody, webhookId: WEBHOOK_ID, getPublicKey });
      expect(result, url).toEqual({ ok: false, reason: "untrusted_cert_url" });
    }
    expect(getPublicKey).not.toHaveBeenCalled();
  });

  it("rejects missing headers and unsupported algorithms", async () => {
    const { "paypal-transmission-sig": _, ...missing } = signedHeaders(rawBody);
    expect(await verifyWebhookSignature({ headers: missing, rawBody, webhookId: WEBHOOK_ID, getPublicKey })).toEqual({ ok: false, reason: "missing_headers" });
    const sha1 = signedHeaders(rawBody, WEBHOOK_ID, { "paypal-auth-algo": "SHA1withRSA" });
    expect(await verifyWebhookSignature({ headers: sha1, rawBody, webhookId: WEBHOOK_ID, getPublicKey })).toEqual({ ok: false, reason: "unsupported_algo" });
  });

  it("reports a cert that cannot be loaded instead of throwing", async () => {
    const failing = async () => {
      throw new Error("network down");
    };
    const result = await verifyWebhookSignature({ headers: signedHeaders(rawBody), rawBody, webhookId: WEBHOOK_ID, getPublicKey: failing });
    expect(result).toEqual({ ok: false, reason: "cert_unavailable" });
  });
});

