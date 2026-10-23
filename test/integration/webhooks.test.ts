import { createPublicKey } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.ts";
import { createDb } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { auditLog, authorizations, mandates, members, pledges, rounds, webhookEvents } from "../../src/db/schema.ts";
import { publicKey, signedHeaders, WEBHOOK_ID } from "../fixtures/webhook-signing.ts";
import { createFreshDatabase } from "./fresh-db.ts";

// S2.6: verified PayPal events land in the webhook_events inbox once (deduped by PayPal's event id),
// are reconciled against our authorizations and captures, and trigger evaluateRound. Webhooks only
// confirm: a replay changes nothing, and an unknown event type is stored and ignored.
const T0 = new Date("2026-10-23T12:00:00.000Z");
const HOUR = 3_600_000;

let fresh: Awaited<ReturnType<typeof createFreshDatabase>>;
let handle: ReturnType<typeof createDb>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  fresh = await createFreshDatabase();
  await runMigrations(fresh.url);
  handle = createDb(fresh.url, { max: 5 });
  app = createApp({
    webhookId: WEBHOOK_ID,
    getPublicKey: async () => createPublicKey(publicKey.export({ type: "spki", format: "pem" })),
    log: () => {},
    webhooks: { db: handle.db, now: () => T0 },
  });
});
afterAll(async () => {
  await handle?.close();
  await fresh?.drop();
});

let n = 0;
const uid = (prefix: string) => `${prefix}-${process.pid}-${++n}`;

// A round with one wallet pledge in the given state; optionally with its authorization row.
async function seed(o: { pledgeStatus: string; authorization?: { id: string; status?: string; captureId?: string } }) {
  const [round] = await handle.db
    .insert(rounds)
    .values({ title: "Beans", sku: "beans", unit: "kg", targetQty: 50, minMembers: 2, pledgeDeadlineAt: new Date(T0.getTime() + 24 * HOUR), deliveryBy: "2026-11-01", supplierRef: "s", status: "open" })
    .returning();
  const [member] = await handle.db.insert(members).values({ displayName: "Maya", businessName: "Maya's Café", kind: "human", publicKeyJwk: { kty: "EC" } }).returning();
  const hash = uid("h").padEnd(64, "0").slice(0, 64);
  const [mandate] = await handle.db
    .insert(mandates)
    .values({ roundId: round!.id, memberId: member!.id, maxUnitPriceCents: 1_400n, qtyMin: 10, qtyMax: 30, deadlineAt: new Date(T0.getTime() + 96 * HOUR), canonicalJson: "{}", hash, signature: "sig" })
    .returning();
  const orderId = uid("ORDER");
  const [pledge] = await handle.db
    .insert(pledges)
    .values({ mandateId: mandate!.id, roundId: round!.id, memberId: member!.id, funding: "paypal_wallet", status: o.pledgeStatus, paypalOrderId: orderId, maxExposureCents: 42_000n })
    .returning();
  if (o.authorization) {
    await handle.db.insert(authorizations).values({
      pledgeId: pledge!.id,
      paypalAuthorizationId: o.authorization.id,
      amountCents: 42_000n,
      status: o.authorization.status ?? "created",
      paypalExpiresAt: new Date(T0.getTime() + 29 * 24 * HOUR),
      honorEndsAt: new Date(T0.getTime() + 72 * HOUR),
      paypalCaptureId: o.authorization.captureId ?? null,
      capturedCents: o.authorization.captureId ? 30_000n : null,
    });
  }
  return { roundId: round!.id, pledgeId: pledge!.id, orderId, hash };
}

// PayPal's shapes (snake_case, as delivered): authorization and capture resources.
const authorizationCreated = (eventId: string, a: { authId: string; orderId: string; customId: string }) => ({
  id: eventId,
  event_version: "1.0",
  create_time: "2026-10-23T12:00:05Z",
  resource_type: "authorization",
  event_type: "PAYMENT.AUTHORIZATION.CREATED",
  resource: {
    id: a.authId,
    status: "CREATED",
    amount: { currency_code: "USD", value: "420.00" },
    custom_id: a.customId,
    create_time: "2026-10-23T12:00:01Z",
    expiration_time: "2026-11-21T12:00:01Z",
    supplementary_data: { related_ids: { order_id: a.orderId } },
  },
});
const authorizationVoided = (eventId: string, authId: string) => ({
  id: eventId,
  event_type: "PAYMENT.AUTHORIZATION.VOIDED",
  resource_type: "authorization",
  resource: { id: authId, status: "VOIDED", amount: { currency_code: "USD", value: "420.00" } },
});
const captureCompleted = (eventId: string, c: { captureId: string; authId: string; value: string }) => ({
  id: eventId,
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource_type: "capture",
  resource: { id: c.captureId, status: "COMPLETED", final_capture: true, amount: { currency_code: "USD", value: c.value }, supplementary_data: { related_ids: { authorization_id: c.authId } } },
});

const deliver = (event: unknown, transmissionId = "tx-1", tamper?: (body: string) => string) => {
  const body = JSON.stringify(event);
  const headers = signedHeaders(body, WEBHOOK_ID, { "paypal-transmission-id": transmissionId });
  return app.request("/webhooks/paypal", { method: "POST", body: tamper ? tamper(body) : body, headers: { "content-type": "application/json", ...headers } });
};

const inboxRows = (eventId: string) => handle.db.select().from(webhookEvents).where(eq(webhookEvents.paypalEventId, eventId));
const authRows = (pledgeId: string) => handle.db.select().from(authorizations).where(eq(authorizations.pledgeId, pledgeId));
const pledgeRow = async (pledgeId: string) => (await handle.db.select().from(pledges).where(eq(pledges.id, pledgeId)))[0]!;
const evaluations = (roundId: string) => handle.db.select().from(auditLog).where(and(eq(auditLog.roundId, roundId), eq(auditLog.action, "evaluate_round")));

describe("PAYMENT.AUTHORIZATION.CREATED", () => {
  it("records a hold whose authorize response was lost, then evaluates the round; replays are no-ops", async () => {
    const s = await seed({ pledgeStatus: "order_created" });
    const authId = uid("AUTH");
    const event = authorizationCreated(uid("WH"), { authId, orderId: s.orderId, customId: s.hash });

    expect((await deliver(event)).status).toBe(200);
    const [auth] = await authRows(s.pledgeId);
    expect(auth).toMatchObject({ paypalAuthorizationId: authId, status: "created", amountCents: 42_000n });
    expect(auth!.paypalExpiresAt.toISOString()).toBe("2026-11-21T12:00:01.000Z");
    expect(auth!.honorEndsAt.toISOString()).toBe(new Date(Date.parse("2026-10-23T12:00:01Z") + 72 * HOUR).toISOString());
    expect((await pledgeRow(s.pledgeId)).status).toBe("authorized");
    const [row] = await inboxRows(event.id);
    expect(row).toMatchObject({ eventType: "PAYMENT.AUTHORIZATION.CREATED", resourceId: authId, verified: true, transmissionId: "tx-1" });
    expect(row!.processedAt).not.toBeNull();
    const evals = await evaluations(s.roundId);
    expect(evals).toHaveLength(1);
    expect(evals[0]!.data).toMatchObject({ decision: "wait", eventId: event.id });

    // The same delivery again, and a PayPal retry of the same event with a new transmission id.
    expect((await deliver(event, "tx-1")).status).toBe(200);
    expect((await deliver(event, "tx-retry-2")).status).toBe(200);
    expect(await inboxRows(event.id)).toHaveLength(1);
    expect(await authRows(s.pledgeId)).toHaveLength(1);
    expect(await evaluations(s.roundId)).toHaveLength(1);
  });

  it("is a no-op for a pledge we already authorized", async () => {
    const authId = uid("AUTH");
    const s = await seed({ pledgeStatus: "authorized", authorization: { id: authId } });
    const before = await authRows(s.pledgeId);

    expect((await deliver(authorizationCreated(uid("WH"), { authId, orderId: s.orderId, customId: s.hash }))).status).toBe(200);

    expect(await authRows(s.pledgeId)).toEqual(before);
    expect((await pledgeRow(s.pledgeId)).status).toBe("authorized");
  });

  it("refuses to record a hold whose custom_id isn't the pledge's mandate hash", async () => {
    const s = await seed({ pledgeStatus: "order_created" });
    const event = authorizationCreated(uid("WH"), { authId: uid("AUTH"), orderId: s.orderId, customId: "f".repeat(64) });

    expect((await deliver(event)).status).toBe(200);

    expect(await authRows(s.pledgeId)).toHaveLength(0);
    expect((await pledgeRow(s.pledgeId)).status).toBe("order_created");
    const flagged = await handle.db.select().from(auditLog).where(and(eq(auditLog.roundId, s.roundId), eq(auditLog.action, "reconcile_mismatch")));
    expect(flagged).toHaveLength(1);
  });
});

describe("PAYMENT.CAPTURE.COMPLETED and PAYMENT.AUTHORIZATION.VOIDED", () => {
  it("confirms a capture once: capture id and amount on the authorization, pledge captured", async () => {
    const authId = uid("AUTH");
    const s = await seed({ pledgeStatus: "capture_pending", authorization: { id: authId } });
    const captureId = uid("CAP");
    const event = captureCompleted(uid("WH"), { captureId, authId, value: "357.00" });

    expect((await deliver(event)).status).toBe(200);
    expect((await deliver(event, "tx-retry-2")).status).toBe(200);

    const rows = await authRows(s.pledgeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "captured", paypalCaptureId: captureId, capturedCents: 35_700n });
    expect((await pledgeRow(s.pledgeId)).status).toBe("captured");
    expect(await inboxRows(event.id)).toHaveLength(1);
  });

  it("confirms a void: authorization voided, pledge voided", async () => {
    const authId = uid("AUTH");
    const s = await seed({ pledgeStatus: "void_pending", authorization: { id: authId } });

    expect((await deliver(authorizationVoided(uid("WH"), authId))).status).toBe(200);

    expect((await authRows(s.pledgeId))[0]).toMatchObject({ status: "voided" });
    expect((await pledgeRow(s.pledgeId)).status).toBe("voided");
  });
});

describe("what is stored but not acted on", () => {
  it("stores an unknown event type and ignores it", async () => {
    const event = { id: uid("WH"), event_type: "BILLING.SUBSCRIPTION.CREATED", resource: { id: "I-123" } };

    expect((await deliver(event)).status).toBe(200);

    const [row] = await inboxRows(event.id);
    expect(row).toMatchObject({ eventType: "BILLING.SUBSCRIPTION.CREATED", verified: true });
    expect(row!.processedAt).not.toBeNull();
  });

  it("stores an event a later slice owns (capture denied) unprocessed, and changes nothing", async () => {
    const authId = uid("AUTH");
    const s = await seed({ pledgeStatus: "capture_pending", authorization: { id: authId } });
    const event = { id: uid("WH"), event_type: "PAYMENT.CAPTURE.DENIED", resource: { id: uid("CAP"), status: "DENIED", supplementary_data: { related_ids: { authorization_id: authId } } } };

    expect((await deliver(event)).status).toBe(200);

    const [row] = await inboxRows(event.id);
    expect(row).toMatchObject({ verified: true, processedAt: null });
    expect((await authRows(s.pledgeId))[0]).toMatchObject({ status: "created", paypalCaptureId: null });
    expect((await pledgeRow(s.pledgeId)).status).toBe("capture_pending");
  });

  it("stores a bad-signature event as unverified and never processes it; it can't pre-empt the real event", async () => {
    const s = await seed({ pledgeStatus: "order_created" });
    const authId = uid("AUTH");
    const event = authorizationCreated(uid("WH"), { authId, orderId: s.orderId, customId: s.hash });

    // A forged copy (body altered after signing) arrives first.
    expect((await deliver(event, "tx-forged", (b) => b.replace('"420.00"', '"1.00"'))).status).toBe(400);
    const [forged] = await inboxRows(event.id);
    expect(forged).toMatchObject({ verified: false, processedAt: null });
    expect(await authRows(s.pledgeId)).toHaveLength(0);

    // The genuine event with the same id is still processed.
    expect((await deliver(event)).status).toBe(200);
    expect((await authRows(s.pledgeId))[0]).toMatchObject({ paypalAuthorizationId: authId, amountCents: 42_000n });
    expect(await inboxRows(event.id)).toHaveLength(2);
  });
});
