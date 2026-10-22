import { Hono } from "hono";
import type { Log } from "../log.ts";
import { verifyWebhookSignature, type GetPublicKey, type WebhookHeaders } from "../webhooks/verify.ts";

export type AppDeps = {
  // Unset until the webhook exists in the PayPal dashboard (it needs this service's URL first).
  webhookId: string | undefined;
  getPublicKey: GetPublicKey;
  pingDb?: () => Promise<void>;
  log: Log;
};

const SIGNATURE_HEADERS = [
  "paypal-transmission-id",
  "paypal-transmission-time",
  "paypal-transmission-sig",
  "paypal-cert-url",
  "paypal-auth-algo",
] as const;

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    if (!deps.pingDb) return c.json({ status: "ok", db: "unconfigured" });
    try {
      await deps.pingDb();
      return c.json({ status: "ok", db: "ok" });
    } catch (err) {
      deps.log("health_db_down", { error: (err as Error).message });
      return c.json({ status: "degraded", db: "down" }, 503);
    }
  });

  app.post("/webhooks/paypal", async (c) => {
    // The signature covers the exact bytes PayPal sent, so read the raw body before any parsing.
    const rawBody = await c.req.text();
    const headers: WebhookHeaders = {};
    for (const name of SIGNATURE_HEADERS) {
      const value = c.req.header(name);
      if (value) headers[name] = value;
    }
    const transmissionId = headers["paypal-transmission-id"];
    if (!deps.webhookId) {
      deps.log("paypal_webhook_rejected", { reason: "webhook_id_unset", transmissionId });
      return c.json({ error: "webhook not configured" }, 503);
    }

    const result = await verifyWebhookSignature({ headers, rawBody, webhookId: deps.webhookId, getPublicKey: deps.getPublicKey });
    if (!result.ok) {
      deps.log("paypal_webhook_rejected", { reason: result.reason, transmissionId });
      return c.json({ error: "invalid signature" }, 400);
    }

    // Ids only: event payloads carry payer details that don't belong in logs.
    const event = safeJson(rawBody) as { id?: string; event_type?: string; resource?: { id?: string } } | undefined;
    deps.log("paypal_webhook", {
      verified: true,
      eventId: event?.id,
      eventType: event?.event_type,
      resourceId: event?.resource?.id,
      transmissionId,
    });
    return c.json({ received: true });
  });

  return app;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
