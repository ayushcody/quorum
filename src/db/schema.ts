import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { OP_KINDS, OP_STATES, type OpKind, type OpState } from "../outbox/kinds.ts";
import { AUTHORIZATION_STATES, PLEDGE_STATES, ROUND_STATES } from "../policy/state.ts";

// Coordinator schema (ARCHITECTURE §6). State vocabularies come from src/policy/state.ts, so the
// CHECK constraints and the policy kernel can't drift apart. Money is integer cents in bigint, currency is USD only, and
// the invariants a bug could break (capture ≤ authorized, one op per business key, one event per
// PayPal id, legal states only) are database constraints, not just app checks.

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const cents = (name: string) => bigint(name, { mode: "bigint" });
const ts = (name: string) => timestamp(name, { withTimezone: true });

// "col in ('a','b')" for a fixed vocabulary. Values must be SQL literals, not bind parameters
// ($1…), because CHECK constraints are DDL. They are compile-time constants defined in this file.
const oneOf = (column: AnyPgColumn, values: readonly string[]): SQL =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "))})`;

// demo_card only on is_demo rounds (DECISIONS D4); enforced by the pledge service (S2.5).
export const FUNDING_KINDS = ["paypal_wallet", "demo_card"] as const;
export const members = pgTable(
  "members",
  {
    id: id(),
    displayName: text("display_name").notNull(),
    businessName: text("business_name").notNull(),
    kind: text("kind").notNull(),
    publicKeyJwk: jsonb("public_key_jwk").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("members_kind", oneOf(t.kind, ["human", "bot"]))],
);

// Private signing keys for demo bot members only (DECISIONS D4: bots sign mandates server-side).
// Sandbox demo data; human members' keys never leave their browser.
export const demoSigningKeys = pgTable("demo_signing_keys", {
  memberId: uuid("member_id").primaryKey().references(() => members.id, { onDelete: "cascade" }),
  privateKeyJwk: jsonb("private_key_jwk").notNull(),
  createdAt: createdAt(),
});

export const rounds = pgTable(
  "rounds",
  {
    id: id(),
    title: text("title").notNull(),
    sku: text("sku").notNull(),
    unit: text("unit").notNull(),
    targetQty: integer("target_qty").notNull(),
    minMembers: integer("min_members").notNull(),
    pledgeDeadlineAt: ts("pledge_deadline_at").notNull(),
    deliveryBy: date("delivery_by").notNull(),
    supplierRef: text("supplier_ref").notNull(),
    status: text("status").notNull().default("draft"),
    version: integer("version").notNull().default(0),
    finalUnitPriceCents: cents("final_unit_price_cents"),
    benchmarkUnitPriceCents: cents("benchmark_unit_price_cents"),
    benchmarkSource: jsonb("benchmark_source"),
    nextTickAt: ts("next_tick_at"),
    negotiationStep: integer("negotiation_step").notNull().default(0),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    check("rounds_status", oneOf(t.status, ROUND_STATES)),
    check("rounds_target_qty", sql`${t.targetQty} > 0`),
    check("rounds_min_members", sql`${t.minMembers} >= 2`),
    check("rounds_final_price", sql`${t.finalUnitPriceCents} is null or ${t.finalUnitPriceCents} > 0`),
    check("rounds_benchmark_price", sql`${t.benchmarkUnitPriceCents} is null or ${t.benchmarkUnitPriceCents} > 0`),
    check("rounds_negotiation_step", sql`${t.negotiationStep} >= 0`),
    index("rounds_status_next_tick").on(t.status, t.nextTickAt),
  ],
);

export const mandates = pgTable(
  "mandates",
  {
    id: id(),
    roundId: uuid("round_id").notNull().references(() => rounds.id),
    memberId: uuid("member_id").notNull().references(() => members.id),
    maxUnitPriceCents: cents("max_unit_price_cents").notNull(),
    qtyMin: integer("qty_min").notNull(),
    qtyMax: integer("qty_max").notNull(),
    deadlineAt: ts("deadline_at").notNull(),
    canonicalJson: text("canonical_json").notNull(),
    hash: char("hash", { length: 64 }).notNull().unique(),
    signature: text("signature").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("mandates_round_member").on(t.roundId, t.memberId),
    check("mandates_max_price", sql`${t.maxUnitPriceCents} > 0`),
    check("mandates_qty", sql`${t.qtyMin} > 0 and ${t.qtyMax} >= ${t.qtyMin}`),
    index("mandates_member").on(t.memberId),
  ],
);

export const pledges = pgTable(
  "pledges",
  {
    id: id(),
    mandateId: uuid("mandate_id").notNull().unique().references(() => mandates.id),
    roundId: uuid("round_id").notNull().references(() => rounds.id),
    memberId: uuid("member_id").notNull().references(() => members.id),
    funding: text("funding").notNull(),
    status: text("status").notNull().default("order_pending"),
    paypalOrderId: text("paypal_order_id").unique(),
    maxExposureCents: cents("max_exposure_cents").notNull(),
    allocatedQty: integer("allocated_qty"),
    captureAmountCents: cents("capture_amount_cents"),
    releasedReason: text("released_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("pledges_funding", oneOf(t.funding, FUNDING_KINDS)),
    check("pledges_status", oneOf(t.status, PLEDGE_STATES)),
    check("pledges_max_exposure", sql`${t.maxExposureCents} > 0`),
    check("pledges_allocated_qty", sql`${t.allocatedQty} is null or ${t.allocatedQty} >= 0`),
    // Invariant 1 at the pledge level: never plan to capture more than the member's maximum exposure.
    check("pledges_capture_le_exposure", sql`${t.captureAmountCents} is null or (${t.captureAmountCents} >= 0 and ${t.captureAmountCents} <= ${t.maxExposureCents})`),
    index("pledges_round_status").on(t.roundId, t.status),
    index("pledges_member").on(t.memberId),
  ],
);

export const authorizations = pgTable(
  "authorizations",
  {
    id: id(),
    pledgeId: uuid("pledge_id").notNull().references(() => pledges.id),
    paypalAuthorizationId: text("paypal_authorization_id").notNull().unique(),
    parentAuthorizationId: uuid("parent_authorization_id").references((): AnyPgColumn => authorizations.id),
    amountCents: cents("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    status: text("status").notNull(),
    // From PayPal's expiration_time (created + 29 d, ARCHITECTURE §3.6).
    paypalExpiresAt: ts("paypal_expires_at").notNull(),
    // created + 72 h; reauthorize only after this (DECISIONS D2).
    honorEndsAt: ts("honor_ends_at").notNull(),
    paypalCaptureId: text("paypal_capture_id").unique(),
    capturedCents: cents("captured_cents"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("authorizations_status", oneOf(t.status, AUTHORIZATION_STATES)),
    check("authorizations_currency", sql`${t.currency} = 'USD'`),
    check("authorizations_amount", sql`${t.amountCents} > 0`),
    check("authorizations_captured_le_amount", sql`${t.capturedCents} is null or (${t.capturedCents} >= 0 and ${t.capturedCents} <= ${t.amountCents})`),
    index("authorizations_pledge").on(t.pledgeId),
    index("authorizations_parent").on(t.parentAuthorizationId),
  ],
);

export const negotiationTurns = pgTable(
  "negotiation_turns",
  {
    id: id(),
    roundId: uuid("round_id").notNull().references(() => rounds.id),
    seq: integer("seq").notNull(),
    side: text("side").notNull(),
    unitPriceCents: cents("unit_price_cents").notNull(),
    qty: integer("qty").notNull(),
    // Supplier text is untrusted: stored verbatim, rendered escaped, never parsed for money.
    message: text("message").notNull(),
    intent: text("intent"),
    policyVerdict: text("policy_verdict"),
    verdictReason: text("verdict_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("negotiation_turns_round_seq").on(t.roundId, t.seq),
    check("negotiation_turns_side", oneOf(t.side, ["buyer", "supplier"])),
    check("negotiation_turns_price", sql`${t.unitPriceCents} > 0`),
    check("negotiation_turns_qty", sql`${t.qty} > 0`),
  ],
);

// The outbox (ARCHITECTURE §5). business_key is the idempotency identity; request_id is sent as
// PayPal-Request-Id (and, for payouts, sender_batch_id is the business key).
export const paypalOps = pgTable(
  "paypal_ops",
  {
    id: id(),
    businessKey: text("business_key").notNull().unique(),
    requestId: uuid("request_id").notNull().unique(),
    kind: text("kind").$type<OpKind>().notNull(),
    mode: text("mode").$type<"inline" | "deferred">().notNull(),
    roundId: uuid("round_id").references(() => rounds.id),
    pledgeId: uuid("pledge_id").references(() => pledges.id),
    request: jsonb("request").notNull(),
    status: text("status").$type<OpState>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    lockedUntil: ts("locked_until"),
    httpStatus: integer("http_status"),
    response: jsonb("response"),
    errorName: text("error_name"),
    paypalDebugId: text("paypal_debug_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("paypal_ops_kind", oneOf(t.kind, OP_KINDS)),
    check("paypal_ops_mode", oneOf(t.mode, ["inline", "deferred"])),
    check("paypal_ops_status", oneOf(t.status, OP_STATES)),
    check("paypal_ops_attempts", sql`${t.attempts} >= 0`),
    index("paypal_ops_due").on(t.status, t.nextAttemptAt),
    index("paypal_ops_round").on(t.roundId),
    index("paypal_ops_pledge").on(t.pledgeId),
  ],
);

// The inbox: one row per PayPal event id, whatever PayPal retries.
// Inbox (ARCHITECTURE §5.5). Dedupe is on PayPal's event id among VERIFIED rows only: a PayPal retry
// reuses the event id with a new transmission id, and a forged copy (stored unverified) must not be able
// to claim a real event's id first.
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    paypalEventId: text("paypal_event_id").notNull(),
    transmissionId: text("transmission_id"),
    eventType: text("event_type").notNull(),
    resourceId: text("resource_id"),
    payload: jsonb("payload").notNull(),
    verified: boolean("verified").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    error: text("error"),
  },
  (t) => [uniqueIndex("webhook_events_verified_event").on(t.paypalEventId).where(sql`${t.verified}`)],
);

// Append-only: a trigger in the migrations refuses UPDATE and DELETE.
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    roundId: uuid("round_id").references(() => rounds.id),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_round").on(t.roundId, t.id)],
);

// Settlement to the supplier (ARCHITECTURE §3.4): invoice → payout → record payment → tracking.
export const fulfillments = pgTable(
  "fulfillments",
  {
    id: id(),
    roundId: uuid("round_id").notNull().unique().references(() => rounds.id),
    paypalInvoiceId: text("paypal_invoice_id").unique(),
    invoiceAmountCents: cents("invoice_amount_cents"),
    invoiceStatus: text("invoice_status"),
    payoutBatchId: text("payout_batch_id").unique(),
    payoutItemId: text("payout_item_id").unique(),
    payoutStatus: text("payout_status"),
    carrier: text("carrier"),
    trackingNumber: text("tracking_number"),
    reportedAt: ts("reported_at").notNull().defaultNow(),
  },
  (t) => [check("fulfillments_invoice_amount", sql`${t.invoiceAmountCents} is null or ${t.invoiceAmountCents} > 0`)],
);

// Channel3 retail benchmark cache (S3.8).
export const benchmarks = pgTable(
  "benchmarks",
  {
    id: id(),
    sku: text("sku").notNull(),
    query: text("query").notNull(),
    bestUnitPriceCents: cents("best_unit_price_cents").notNull(),
    retailer: text("retailer").notNull(),
    url: text("url").notNull(),
    raw: jsonb("raw").notNull(),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
  },
  (t) => [check("benchmarks_price", sql`${t.bestUnitPriceCents} > 0`), index("benchmarks_sku").on(t.sku, t.fetchedAt)],
);
