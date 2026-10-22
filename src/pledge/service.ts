import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { authorizations, demoSigningKeys, mandates, members, pledges, rounds } from "../db/schema.ts";
import { runInline, type CallDeps } from "../paypal/call.ts";
import { fromDollars } from "../policy/money.ts";
import { maxExposure } from "../policy/mandate.ts";
import { signMandate, toMandatePayload, verifyMandate, type PublicKeyJwk, type VerifiedMandate } from "./mandate-sign.ts";

// The pledge flow (ARCHITECTURE §3.1, §3.3):
//   human: signed mandate → AUTHORIZE order for the max exposure (custom_id = mandate hash)
//          → buyer approves in the JS SDK v6 popup → authorize → authorization row (72 h honor)
//   bot (demo rounds only, D4): the same, but one card order comes back already authorized.
// Every PayPal call goes through runInline: an outbox row first, its request id as PayPal-Request-Id.

export type PledgeDeps = CallDeps;
export type PledgeError =
  | "round_not_found" | "round_closed" | "member_not_found" | "not_bot" | "malformed_payload" | "invalid_mandate"
  | "bad_key" | "bad_signature" | "payload_mismatch" | "already_pledged" | "not_demo_round" | "paypal_failed"
  | "paypal_pending" | "pledge_not_found" | "no_order";
type Fail = { ok: false; error: PledgeError };

const HONOR_MS = 72 * 3_600_000;
const VALIDITY_MS = 29 * 24 * 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (error: PledgeError): Fail => ({ ok: false, error });

const publicKeySchema = z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().min(1), y: z.string().min(1) }).passthrough();
export const registerSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  businessName: z.string().trim().min(1).max(120),
  publicKeyJwk: publicKeySchema,
});

export async function registerMember(db: Db, input: z.infer<typeof registerSchema>): Promise<{ memberId: string }> {
  const { kty, crv, x, y } = input.publicKeyJwk;
  const [row] = await db
    .insert(members)
    .values({ displayName: input.displayName, businessName: input.businessName, kind: "human", publicKeyJwk: { kty, crv, x, y } })
    .returning({ id: members.id });
  return { memberId: row!.id };
}

async function openRound(deps: PledgeDeps, roundId: string) {
  if (!UUID.test(roundId)) return fail("round_not_found");
  const [round] = await deps.db.select().from(rounds).where(eq(rounds.id, roundId));
  if (!round) return fail("round_not_found");
  if (round.status !== "open" || deps.now().getTime() >= round.pledgeDeadlineAt.getTime()) return fail("round_closed");
  return { ok: true as const, round };
}

// Insert the verified mandate and its pledge, or return the pledge an identical mandate already made.
async function recordPledge(deps: PledgeDeps, mandate: VerifiedMandate, canonical: string, signature: string, funding: "paypal_wallet" | "demo_card") {
  const [existing] = await deps.db.select({ pledge: pledges }).from(pledges).innerJoin(mandates, eq(mandates.id, pledges.mandateId)).where(eq(mandates.hash, mandate.hash));
  if (existing) return { ok: true as const, pledge: existing.pledge, created: false };
  const [sameMember] = await deps.db.select({ id: mandates.id }).from(mandates).where(and(eq(mandates.roundId, mandate.roundId), eq(mandates.memberId, mandate.memberId)));
  if (sameMember) return fail("already_pledged");

  const pledge = await deps.db.transaction(async (tx) => {
    const [m] = await tx
      .insert(mandates)
      .values({
        roundId: mandate.roundId,
        memberId: mandate.memberId,
        maxUnitPriceCents: mandate.maxUnitPriceCents,
        qtyMin: mandate.qtyMin,
        qtyMax: mandate.qtyMax,
        deadlineAt: mandate.deadlineAt,
        canonicalJson: canonical,
        hash: mandate.hash,
        signature,
      })
      .returning({ id: mandates.id });
    const [p] = await tx
      .insert(pledges)
      .values({ mandateId: m!.id, roundId: mandate.roundId, memberId: mandate.memberId, funding, status: "order_pending", maxExposureCents: maxExposure(mandate) })
      .returning();
    return p!;
  });
  return { ok: true as const, pledge, created: true };
}

type PledgeRow = typeof pledges.$inferSelect;

function createOrder(deps: PledgeDeps, pledge: PledgeRow, mandateHash: string) {
  return runInline(deps, {
    businessKey: `create_order:${pledge.id}`,
    kind: "create_order",
    mode: "inline",
    request: { amountCents: pledge.maxExposureCents.toString(), customId: mandateHash, invoiceId: pledge.id, funding: pledge.funding as "paypal_wallet" | "demo_card" },
    roundId: pledge.roundId,
    pledgeId: pledge.id,
  });
}

type AuthBody = { id?: string; status?: string; amount?: { value?: string }; createTime?: string; expirationTime?: string };
function firstAuthorization(order: unknown): AuthBody | undefined {
  const o = order as { purchaseUnits?: Array<{ payments?: { authorizations?: AuthBody[] } }> } | null;
  return o?.purchaseUnits?.[0]?.payments?.authorizations?.[0];
}

// One authorization row per PayPal authorization, written with the pledge's move to `authorized`.
async function recordAuthorization(deps: PledgeDeps, pledge: PledgeRow, auth: AuthBody, orderId: string) {
  const created = auth.createTime ? new Date(auth.createTime) : deps.now();
  const expires = auth.expirationTime ? new Date(auth.expirationTime) : new Date(created.getTime() + VALIDITY_MS);
  await deps.db.transaction(async (tx) => {
    await tx
      .insert(authorizations)
      .values({
        pledgeId: pledge.id,
        paypalAuthorizationId: auth.id!,
        amountCents: auth.amount?.value ? fromDollars(auth.amount.value) : pledge.maxExposureCents,
        currency: "USD",
        status: "created",
        paypalExpiresAt: expires,
        honorEndsAt: new Date(created.getTime() + HONOR_MS),
      })
      .onConflictDoNothing({ target: authorizations.paypalAuthorizationId });
    await tx.update(pledges).set({ status: "authorized", paypalOrderId: orderId, updatedAt: deps.now() }).where(eq(pledges.id, pledge.id));
  });
}

export type SubmitResult = { ok: true; created: boolean; pledgeId: string; orderId: string; mandateHash: string } | Fail;

export async function submitPledge(deps: PledgeDeps, input: { roundId: string; memberId: string; payload: unknown; signature: string }): Promise<SubmitResult> {
  const open = await openRound(deps, input.roundId);
  if (!open.ok) return open;
  if (!UUID.test(input.memberId)) return fail("member_not_found");
  const [member] = await deps.db.select().from(members).where(eq(members.id, input.memberId));
  if (!member) return fail("member_not_found");

  const verified = await verifyMandate({ payload: input.payload, signature: input.signature, publicKeyJwk: member.publicKeyJwk as PublicKeyJwk });
  if (!verified.ok) return fail(verified.reason);
  if (verified.mandate.roundId !== input.roundId || verified.mandate.memberId !== input.memberId) return fail("payload_mismatch");

  const recorded = await recordPledge(deps, verified.mandate, verified.canonicalJson, input.signature, "paypal_wallet");
  if (!recorded.ok) return recorded;
  const { pledge } = recorded;
  if (pledge.paypalOrderId) return { ok: true, created: false, pledgeId: pledge.id, orderId: pledge.paypalOrderId, mandateHash: verified.hash };

  const op = await createOrder(deps, pledge, verified.hash);
  if (op.status !== "succeeded") return fail(op.status === "failed_terminal" ? "paypal_failed" : "paypal_pending");
  const orderId = (op.response as { id: string }).id;
  await deps.db.update(pledges).set({ status: "order_created", paypalOrderId: orderId, updatedAt: deps.now() }).where(eq(pledges.id, pledge.id));
  return { ok: true, created: recorded.created, pledgeId: pledge.id, orderId, mandateHash: verified.hash };
}

// After the buyer approves in the v6 popup. Safe to call again: it returns the existing authorization.
export async function authorizePledge(deps: PledgeDeps, pledgeId: string): Promise<{ ok: true; pledgeId: string; authorizationId: string } | Fail> {
  if (!UUID.test(pledgeId)) return fail("pledge_not_found");
  const [pledge] = await deps.db.select().from(pledges).where(eq(pledges.id, pledgeId));
  if (!pledge) return fail("pledge_not_found");
  const [existing] = await deps.db.select().from(authorizations).where(eq(authorizations.pledgeId, pledgeId));
  if (existing) return { ok: true, pledgeId, authorizationId: existing.paypalAuthorizationId };
  if (!pledge.paypalOrderId) return fail("no_order");

  const op = await runInline(deps, {
    businessKey: `authorize:${pledge.paypalOrderId}`,
    kind: "authorize_order",
    mode: "inline",
    request: { orderId: pledge.paypalOrderId },
    roundId: pledge.roundId,
    pledgeId,
  });
  if (op.status !== "succeeded") return fail(op.status === "failed_terminal" ? "paypal_failed" : "paypal_pending");
  const auth = firstAuthorization(op.response);
  if (!auth?.id) return fail("paypal_failed");
  await recordAuthorization(deps, pledge, auth, pledge.paypalOrderId);
  return { ok: true, pledgeId, authorizationId: auth.id };
}

// Demo-mode bot member (D4): signs its mandate with its server-held key, and one card order comes
// back already authorized. Refused on any round that isn't a demo round, before anything is written.
export async function pledgeAsBot(
  deps: PledgeDeps,
  input: { roundId: string; memberId: string; maxUnitPriceCents: bigint; qtyMin: number; qtyMax: number; deadlineAt: Date },
): Promise<{ ok: true; pledgeId: string; authorizationId: string } | Fail> {
  const open = await openRound(deps, input.roundId);
  if (!open.ok) return open;
  if (!open.round.isDemo) return fail("not_demo_round");
  const [bot] = await deps.db.select({ member: members, key: demoSigningKeys }).from(members).innerJoin(demoSigningKeys, eq(demoSigningKeys.memberId, members.id)).where(eq(members.id, input.memberId));
  if (!bot || bot.member.kind !== "bot") return fail("not_bot");

  const privateKey = await globalThis.crypto.subtle.importKey("jwk", bot.key.privateKeyJwk as PublicKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const payload = toMandatePayload(input);
  const signature = await signMandate(payload, privateKey);
  const verified = await verifyMandate({ payload, signature, publicKeyJwk: bot.member.publicKeyJwk as PublicKeyJwk });
  if (!verified.ok) return fail(verified.reason);

  const recorded = await recordPledge(deps, verified.mandate, verified.canonicalJson, signature, "demo_card");
  if (!recorded.ok) return recorded;
  const op = await createOrder(deps, recorded.pledge, verified.hash);
  if (op.status !== "succeeded") return fail(op.status === "failed_terminal" ? "paypal_failed" : "paypal_pending");
  const order = op.response as { id: string };
  const auth = firstAuthorization(order);
  if (!auth?.id) return fail("paypal_failed");
  await recordAuthorization(deps, recorded.pledge, auth, order.id);
  return { ok: true, pledgeId: recorded.pledge.id, authorizationId: auth.id };
}

// Live progress counts authorized holds only: an order nobody approved isn't money in the round.
async function progressOf(db: Db, roundIds: string[]): Promise<Map<string, { pledgedQty: number; members: number }>> {
  const out = new Map(roundIds.map((id) => [id, { pledgedQty: 0, members: 0 }]));
  if (roundIds.length === 0) return out;
  const rows = await db
    .select({ roundId: pledges.roundId, qtyMax: mandates.qtyMax })
    .from(pledges)
    .innerJoin(mandates, eq(mandates.id, pledges.mandateId))
    .where(and(inArray(pledges.roundId, roundIds), eq(pledges.status, "authorized")));
  for (const r of rows) {
    const p = out.get(r.roundId)!;
    p.pledgedQty += r.qtyMax;
    p.members += 1;
  }
  return out;
}

const summaryOf = (round: typeof rounds.$inferSelect, progress: { pledgedQty: number; members: number }) => ({
  id: round.id,
  title: round.title,
  sku: round.sku,
  unit: round.unit,
  targetQty: round.targetQty,
  minMembers: round.minMembers,
  status: round.status,
  pledgeDeadlineAt: round.pledgeDeadlineAt.toISOString(),
  deliveryBy: round.deliveryBy,
  isDemo: round.isDemo,
  progress,
});

export async function roundSummary(db: Db, roundId: string) {
  if (!UUID.test(roundId)) return undefined;
  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
  if (!round) return undefined;
  return summaryOf(round, (await progressOf(db, [round.id])).get(round.id)!);
}

// Rounds still taking pledges, soonest deadline first.
export async function openRounds(db: Db, now: Date) {
  const open = await db.select().from(rounds).where(and(eq(rounds.status, "open"), gt(rounds.pledgeDeadlineAt, now))).orderBy(asc(rounds.pledgeDeadlineAt));
  const progress = await progressOf(db, open.map((r) => r.id));
  return open.map((r) => summaryOf(r, progress.get(r.id)!));
}
