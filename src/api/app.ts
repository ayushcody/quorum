import { Hono } from "hono";
import type { Log } from "../log.ts";
import { pledgeRoutes } from "../pledge/routes.ts";
import type { PledgeDeps } from "../pledge/service.ts";
import { parseEvent, receiveVerified, storeUnverified, type InboxDeps } from "../webhooks/handlers.ts";
import { verifyWebhookSignature, type GetPublicKey, type WebhookHeaders } from "../webhooks/verify.ts";

export type AppDeps = {
  // Unset until the webhook exists in the PayPal dashboard (it needs this service's URL first).
  webhookId: string | undefined;
  getPublicKey: GetPublicKey;
  pingDb?: () => Promise<void>;
  log: Log;
  // Pledge API (S2.5); absent when no database is configured.
  pledges?: PledgeDeps & { paypalClientId: string };
  // Webhook inbox (S2.6); absent when no database is configured, and the route only verifies and logs.
  webhooks?: InboxDeps;
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
      if (deps.webhooks) await storeUnverified(deps.webhooks, safeJson(rawBody), rawBody, transmissionId).catch((err: Error) => deps.log("paypal_webhook_store_failed", { error: err.message, transmissionId }));
      return c.json({ error: "invalid signature" }, 400);
    }

    // Ids only: event payloads carry payer details that don't belong in logs.
    const event = safeJson(rawBody) as { id?: string; event_type?: string; resource?: { id?: string } } | undefined;
    const ids = { eventId: event?.id, eventType: event?.event_type, resourceId: event?.resource?.id, transmissionId };
    if (!deps.webhooks) {
      deps.log("paypal_webhook", { verified: true, ...ids });
      return c.json({ received: true });
    }

    const parsed = parseEvent(event);
    if (!parsed) {
      deps.log("paypal_webhook_rejected", { reason: "malformed_event", ...ids });
      return c.json({ error: "malformed event" }, 400);
    }
    try {
      const outcome = await receiveVerified(deps.webhooks, parsed, transmissionId);
      deps.log("paypal_webhook", { verified: true, outcome, ...ids });
      return c.json({ received: true });
    } catch (err) {
      // Not stored (the transaction rolled back), so PayPal's retry will be processed in full.
      deps.log("paypal_webhook_failed", { error: (err as Error).message, ...ids });
      return c.json({ error: "processing failed" }, 500);
    }
  });

  if (deps.pledges) app.route("/", pledgeRoutes(deps.pledges));
  else app.all("/api/*", (c) => c.json({ error: "database not configured" }, 503));

  return app;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
