import { generateKeyPairSync, sign } from "node:crypto";
import { crc32 } from "node:zlib";
import { CERT_URL_PREFIX, type WebhookHeaders } from "../../src/webhooks/verify.ts";

// Signs test webhooks with a local key in PayPal's documented format:
// "<transmission_id>|<transmission_time>|<webhook_id>|<crc32(raw body)>", SHA256withRSA, base64.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

export { publicKey };
export const WEBHOOK_ID = "WH-TEST-123";
export const rawBody = JSON.stringify({ id: "WH-EVT-1", event_type: "PAYMENT.AUTHORIZATION.CREATED", resource: { id: "AUTH-1" } });

export function signedHeaders(body: string, webhookId = WEBHOOK_ID, overrides: Partial<WebhookHeaders> = {}): WebhookHeaders {
  const transmissionId = "tx-1";
  const transmissionTime = "2026-10-22T12:00:00Z";
  const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(Buffer.from(body))}`;
  return {
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-time": transmissionTime,
    "paypal-transmission-sig": sign("sha256", Buffer.from(message), privateKey).toString("base64"),
    "paypal-cert-url": `${CERT_URL_PREFIX}CERT-360caa42-fca2a594-test`,
    "paypal-auth-algo": "SHA256withRSA",
    ...overrides,
  };
}
