import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { auditLog, authorizations, mandates, pledges, webhookEvents } from "../db/schema.ts";
import { loadRoundSnapshot } from "../db/snapshot.ts";
import { writeAuthorization } from "../pledge/service.ts";
import { canTransitionPledge, evaluateRound, fromDollars, type PledgeStatus } from "../policy/index.ts";

// The webhook inbox (ARCHITECTURE §5.5, S2.6). A verified event is stored once (deduped on PayPal's
// event id), reconciled against our authorizations and captures, and then evaluateRound runs for its
// round. Webhooks only confirm what our own API calls already recorded, so a replay changes nothing.
// The decision is audited, not acted on: capturing and voiding belong to settlement/worker.ts (S2.7).

export type InboxDeps = { db: Db; now: () => Date };
export type InboxOutcome = "applied" | "no_change" | "duplicate" | "unmatched" | "mismatch" | "conflict" | "deferred" | "ignored";

const eventSchema = z.object({ id: z.string().min(1), event_type: z.string().min(1), resource: z.record(z.string(), z.unknown()).optional() });
type Event = z.infer<typeof eventSchema>;

// Known event types whose handling belongs to a later slice: stored, left unprocessed for that slice.
const DEFERRED = new Set(["PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", "PAYMENT.PAYOUTS-ITEM.FAILED", "CUSTOMER.DISPUTE.CREATED"]);

type Reconciled = { outcome: InboxOutcome; roundId?: string };
type Resource = {
  id?: string;
  status?: string;
  custom_id?: string;
  create_time?: string;
  expiration_time?: string;
  amount?: { value?: string; currency_code?: string };
  supplementary_data?: { related_ids?: { order_id?: string; authorization_id?: string } };
};

export function parseEvent(body: unknown): Event | undefined {
  const parsed = eventSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

export async function receiveVerified(deps: InboxDeps, event: Event, transmissionId: string | undefined): Promise<InboxOutcome> {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(webhookEvents)
      .values({ paypalEventId: event.id, transmissionId, eventType: event.event_type, resourceId: (event.resource as Resource | undefined)?.id ?? null, payload: event, verified: true })
      .onConflictDoNothing({ target: webhookEvents.paypalEventId, where: sql`verified` })
      .returning({ id: webhookEvents.id });
    if (!row) return "duplicate";
    if (DEFERRED.has(event.event_type)) return "deferred";

    const result = await reconcile(tx, event, now);
    if (result.roundId) {
      const snapshot = await loadRoundSnapshot(tx, result.roundId);
      if (snapshot) {
        const decision = evaluateRound(snapshot, now);
        await audit(tx, result.roundId, "policy", "evaluate_round", { eventId: event.id, eventType: event.event_type, decision: decision.kind, ...("reason" in decision ? { reason: decision.reason } : {}) });
      }
    }
    await tx.update(webhookEvents).set({ processedAt: now }).where(eq(webhookEvents.id, row.id));
    return result.outcome;
  });
}

// A bad signature: kept for the record (verified=false, never processed). It can't block the real
// event, because dedupe only counts verified rows.
export async function storeUnverified(deps: InboxDeps, body: unknown, rawBody: string, transmissionId: string | undefined): Promise<void> {
  const e = body as { id?: unknown; event_type?: unknown; resource?: { id?: unknown } } | undefined;
  await deps.db.insert(webhookEvents).values({
    paypalEventId: typeof e?.id === "string" ? e.id : `unverified:${transmissionId ?? "none"}`,
    transmissionId,
    eventType: typeof e?.event_type === "string" ? e.event_type : "unknown",
    resourceId: typeof e?.resource?.id === "string" ? e.resource.id : null,
    payload: e ?? { raw: rawBody.slice(0, 4096) },
    verified: false,
  });
}

async function reconcile(tx: Tx, event: Event, now: Date): Promise<Reconciled> {
  const r = (event.resource ?? {}) as Resource;
  switch (event.event_type) {
    case "PAYMENT.AUTHORIZATION.CREATED":
      return authorizationCreated(tx, event, r, now);
    case "PAYMENT.AUTHORIZATION.VOIDED":
      return authorizationVoided(tx, event, r, now);
    case "PAYMENT.CAPTURE.COMPLETED":
      return captureCompleted(tx, event, r, now);
    default:
      return { outcome: "ignored" };
  }
}

// The hold exists at PayPal. Usually our authorize response already recorded it; if that response was
// lost, record it now, but only if it is provably this pledge's: mandate hash in custom_id, same amount.
async function authorizationCreated(tx: Tx, event: Event, r: Resource, now: Date): Promise<Reconciled> {
  if (!r.id) return { outcome: "unmatched" };
  const [known] = await tx.select({ roundId: pledges.roundId }).from(authorizations).innerJoin(pledges, eq(pledges.id, authorizations.pledgeId)).where(eq(authorizations.paypalAuthorizationId, r.id));
  if (known) return { outcome: "no_change", roundId: known.roundId };

  const orderId = r.supplementary_data?.related_ids?.order_id;
  if (!orderId) return { outcome: "unmatched" };
  const [found] = await tx.select({ pledge: pledges, hash: mandates.hash }).from(pledges).innerJoin(mandates, eq(mandates.id, pledges.mandateId)).where(eq(pledges.paypalOrderId, orderId));
  if (!found) return { outcome: "unmatched" };
  const { pledge } = found;

  const amount = r.amount?.value ? fromDollars(r.amount.value) : undefined;
  if (r.custom_id !== found.hash || amount !== pledge.maxExposureCents || (r.amount?.currency_code ?? "USD") !== "USD") {
    await audit(tx, pledge.roundId, "webhook", "reconcile_mismatch", { eventId: event.id, authorizationId: r.id, pledgeId: pledge.id, customIdMatches: r.custom_id === found.hash, amount: r.amount?.value ?? null });
    return { outcome: "mismatch" };
  }
  if (!canTransitionPledge(pledge.status as PledgeStatus, "authorized")) {
    await audit(tx, pledge.roundId, "webhook", "reconcile_conflict", { eventId: event.id, authorizationId: r.id, pledgeId: pledge.id, pledgeStatus: pledge.status });
    return { outcome: "conflict", roundId: pledge.roundId };
  }

  await writeAuthorization(tx, pledge, { id: r.id, amount: { value: r.amount!.value! }, ...(r.create_time ? { createTime: r.create_time } : {}), ...(r.expiration_time ? { expirationTime: r.expiration_time } : {}) }, orderId, now);
  await audit(tx, pledge.roundId, "webhook", "reconcile_authorization", { eventId: event.id, authorizationId: r.id, pledgeId: pledge.id });
  return { outcome: "applied", roundId: pledge.roundId };
}

async function findAuthorization(tx: Tx, paypalAuthorizationId: string | undefined) {
  if (!paypalAuthorizationId) return undefined;
  const [row] = await tx.select({ auth: authorizations, pledge: pledges }).from(authorizations).innerJoin(pledges, eq(pledges.id, authorizations.pledgeId)).where(eq(authorizations.paypalAuthorizationId, paypalAuthorizationId));
  return row;
}

// Move the pledge to its final state if the state machine allows it from where it is; `via` is the
// pending state our own worker would have set first (an action taken outside Quorum skips it).
async function settlePledge(tx: Tx, event: Event, pledge: typeof pledges.$inferSelect, via: PledgeStatus, to: PledgeStatus, now: Date): Promise<boolean> {
  const from = pledge.status as PledgeStatus;
  const direct = canTransitionPledge(from, to);
  const external = !direct && canTransitionPledge(from, via) && canTransitionPledge(via, to);
  if (!direct && !external) {
    await audit(tx, pledge.roundId, "webhook", "reconcile_conflict", { eventId: event.id, pledgeId: pledge.id, pledgeStatus: from, wanted: to });
    return false;
  }
  if (external) await audit(tx, pledge.roundId, "webhook", "reconcile_external_action", { eventId: event.id, pledgeId: pledge.id, from, to });
  await tx.update(pledges).set({ status: to, updatedAt: now }).where(eq(pledges.id, pledge.id));
  return true;
}

async function authorizationVoided(tx: Tx, event: Event, r: Resource, now: Date): Promise<Reconciled> {
  const found = await findAuthorization(tx, r.id);
  if (!found) return { outcome: "unmatched" };
  const { auth, pledge } = found;
  if (auth.status === "voided" && pledge.status === "voided") return { outcome: "no_change", roundId: pledge.roundId };
  if (auth.status !== "created" && auth.status !== "voided") {
    await audit(tx, pledge.roundId, "webhook", "reconcile_conflict", { eventId: event.id, authorizationId: auth.paypalAuthorizationId, authorizationStatus: auth.status });
    return { outcome: "conflict", roundId: pledge.roundId };
  }
  await tx.update(authorizations).set({ status: "voided", updatedAt: now }).where(eq(authorizations.id, auth.id));
  const moved = pledge.status === "voided" || (await settlePledge(tx, event, pledge, "void_pending", "voided", now));
  return { outcome: moved ? "applied" : "conflict", roundId: pledge.roundId };
}

async function captureCompleted(tx: Tx, event: Event, r: Resource, now: Date): Promise<Reconciled> {
  const found = await findAuthorization(tx, r.supplementary_data?.related_ids?.authorization_id);
  if (!found || !r.id || !r.amount?.value) return { outcome: "unmatched" };
  const { auth, pledge } = found;
  if (auth.paypalCaptureId === r.id) return { outcome: "no_change", roundId: pledge.roundId };
  const captured = fromDollars(r.amount.value);
  // A second capture on one authorization, or more than the hold: never written, always flagged.
  if (auth.paypalCaptureId !== null || captured > auth.amountCents || (r.amount.currency_code ?? "USD") !== "USD") {
    await audit(tx, pledge.roundId, "webhook", "reconcile_conflict", { eventId: event.id, authorizationId: auth.paypalAuthorizationId, captureId: r.id, recordedCaptureId: auth.paypalCaptureId, amount: r.amount.value });
    return { outcome: "conflict", roundId: pledge.roundId };
  }
  await tx.update(authorizations).set({ status: "captured", paypalCaptureId: r.id, capturedCents: captured, updatedAt: now }).where(eq(authorizations.id, auth.id));
  const moved = await settlePledge(tx, event, pledge, "capture_pending", "captured", now);
  return { outcome: moved ? "applied" : "conflict", roundId: pledge.roundId };
}

function audit(tx: Tx, roundId: string, actor: string, action: string, data: Record<string, unknown>) {
  return tx.insert(auditLog).values({ roundId, actor, action, data });
}
