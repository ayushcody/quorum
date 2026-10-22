import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { paypalOps } from "../../src/db/schema.ts";
import { requestIdFor } from "../../src/outbox/request-id.ts";
import { claimDue, claimOne, completeOp, enqueueOp, markStaleInFlight, type EnqueueArgs } from "../../src/outbox/repo.ts";
import { backoffMs, MAX_ATTEMPTS, paypalCall, reconcileOp, runInline } from "../../src/paypal/call.ts";
import { FakePayPal } from "../../src/paypal/fake.ts";
import { createFreshDatabase } from "./fresh-db.ts";

// S2.4: every PayPal call has a committed outbox row first, and the row's request id is the
// PayPal-Request-Id. FakePayPal stands in for PayPal; the database is real.
const T0 = new Date("2026-10-22T12:00:00.000Z");
const MINUTES = (n: number) => n * 60_000;

let fresh: Awaited<ReturnType<typeof createFreshDatabase>>;
let handle: ReturnType<typeof createDb>;
let clock: Date;
const now = () => clock;

beforeAll(async () => {
  fresh = await createFreshDatabase();
  await runMigrations(fresh.url);
  handle = createDb(fresh.url, { max: 5 });
});
afterAll(async () => {
  await handle?.close();
  await fresh?.drop();
});

function setup() {
  clock = new Date(T0);
  const port = new FakePayPal();
  return { port, deps: { db: handle.db, port, now } };
}
const rowsFor = (key: string) => handle.db.select().from(paypalOps).where(eq(paypalOps.businessKey, key));
const captureArgs = (authId: string, amountCents = "1000"): EnqueueArgs => ({ businessKey: `capture:${authId}`, kind: "capture", mode: "deferred", request: { authorizationId: authId, amountCents } });
const sends = (port: FakePayPal, kind: string) => port.calls.filter((c) => c.kind === kind);

describe("outbox: one row, one send, one request id", () => {
  it("runs the same business key twice through runInline as one row and one send, and returns the stored success the second time", async () => {
    const { port, deps } = setup();
    port.seedAuthorization({ authorizationId: "AUTH-1", amountCents: "1000" });
    const args = captureArgs("AUTH-1");

    const first = await runInline(deps, args);
    const second = await runInline(deps, args);

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(second.id).toBe(first.id);
    expect(second.response).toEqual(first.response);
    expect(await rowsFor(args.businessKey)).toHaveLength(1);
    expect(sends(port, "capture")).toHaveLength(1);
    expect(port.authorization("AUTH-1")).toMatchObject({ status: "CAPTURED", capturedCents: "1000" });
  });

  it("enqueueOp returns the existing row for a repeated business key, with request_id = requestIdFor(key)", async () => {
    const { deps } = setup();
    const args = captureArgs("AUTH-ENQ");
    const a = await enqueueOp(deps.db, args);
    const b = await enqueueOp(deps.db, { ...args, request: { authorizationId: "AUTH-ENQ", amountCents: "9999" } });

    expect(b.id).toBe(a.id);
    expect(a.requestId).toBe(requestIdFor(args.businessKey));
    expect(a.status).toBe("pending");
    expect(b.request).toEqual({ authorizationId: "AUTH-ENQ", amountCents: "1000" });
    expect(await rowsFor(args.businessKey)).toHaveLength(1);
  });

  it("after a crash between insert and call, runInline with the same args sends exactly once with requestIdFor(businessKey)", async () => {
    const { port, deps } = setup();
    port.seedAuthorization({ authorizationId: "AUTH-2", amountCents: "1000" });
    const args = captureArgs("AUTH-2");
    const inserted = await enqueueOp(deps.db, args);
    expect(port.calls).toHaveLength(0);

    const row = await runInline(deps, args);

    expect(row.id).toBe(inserted.id);
    expect(row.status).toBe("succeeded");
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toMatchObject({ kind: "capture", requestId: requestIdFor(args.businessKey), params: { authorizationId: "AUTH-2", amountCents: "1000" } });
  });

  it("leaves a row another process holds in_flight alone: no send, returned unchanged", async () => {
    const { port, deps } = setup();
    port.seedAuthorization({ authorizationId: "AUTH-HELD", amountCents: "1000" });
    const args = captureArgs("AUTH-HELD");
    const enqueued = await enqueueOp(deps.db, args);
    expect(await claimOne(deps.db, enqueued.id, now())).not.toBeNull();

    const row = await runInline(deps, args);

    expect(row.status).toBe("in_flight");
    expect(port.calls).toHaveLength(0);
  });
});

describe("outbox: ambiguous outcomes are settled by a GET, never by a blind resend", () => {
  it("capture that timed out after PayPal applied it: unknown, then reconcile finds it done, with one capture and the GET as its own row", async () => {
    const { port, deps } = setup();
    port.seedAuthorization({ authorizationId: "AUTH-3", amountCents: "1000" });
    port.failNext("capture", "timeout_after_apply");
    const args = captureArgs("AUTH-3");

    const unknown = await runInline(deps, args);
    expect(unknown.status).toBe("unknown");
    expect(unknown.attempts).toBe(1);
    expect(unknown.httpStatus).toBeNull();

    const settled = await reconcileOp(deps, unknown);

    expect(settled.status).toBe("succeeded");
    expect(sends(port, "capture")).toHaveLength(1);
    expect(port.authorization("AUTH-3")).toMatchObject({ status: "CAPTURED", capturedCents: "1000" });
    const reads = await rowsFor(`get:capture:${args.businessKey}:1`);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ kind: "get_authorization", status: "succeeded" });
    expect(reads[0]!.requestId).toBe(requestIdFor(`get:capture:${args.businessKey}:1`));
    expect(sends(port, "get_authorization")).toHaveLength(1);
  });

  it("capture that timed out before PayPal applied it: unknown, reconcile says pending, the next call resends with the same request id and captures once", async () => {
    const { port, deps } = setup();
    port.seedAuthorization({ authorizationId: "AUTH-4", amountCents: "1000" });
    port.failNext("capture", "timeout_before_apply");
    const args = captureArgs("AUTH-4");

    const unknown = await runInline(deps, args);
    expect(unknown.status).toBe("unknown");
    const pending = await reconcileOp(deps, unknown);
    expect(pending.status).toBe("pending");
    expect(port.authorization("AUTH-4")).toMatchObject({ status: "CREATED" });

    clock = new Date(T0.getTime() + MINUTES(60));
    const claimed = await claimOne(deps.db, pending.id, now());
    expect(claimed).not.toBeNull();
    const done = await paypalCall(deps, claimed!);

    expect(done.status).toBe("succeeded");
    const captures = sends(port, "capture");
    expect(captures).toHaveLength(2);
    expect(captures[1]!.requestId).toBe(captures[0]!.requestId);
    expect(captures[0]!.requestId).toBe(requestIdFor(args.businessKey));
    expect(port.authorization("AUTH-4")).toMatchObject({ status: "CAPTURED", capturedCents: "1000" });
  });

  it("422 on a capture of an already-captured authorization: unknown, reconcile observes CAPTURED, succeeded", async () => {
    const { port, deps } = setup();
    port.seedAuthorization({ authorizationId: "AUTH-5A", amountCents: "1000", status: "CAPTURED" });

    const unknown = await runInline(deps, captureArgs("AUTH-5A"));
    expect(unknown.status).toBe("unknown");
    expect(unknown.httpStatus).toBe(422);

    const settled = await reconcileOp(deps, unknown);
    expect(settled.status).toBe("succeeded");
  });

  it("422 CAPTURE_AMOUNT_EXCEEDS_AUTHORIZED on a CREATED authorization: unknown, reconcile sees nothing captured, failed_terminal", async () => {
    const { port, deps } = setup();
    port.seedAuthorization({ authorizationId: "AUTH-5B", amountCents: "1000" });

    const unknown = await runInline(deps, captureArgs("AUTH-5B", "1500"));
    expect(unknown.status).toBe("unknown");
    expect(unknown.httpStatus).toBe(422);

    const settled = await reconcileOp(deps, unknown);

    expect(settled.status).toBe("failed_terminal");
    expect(port.authorization("AUTH-5B")).toMatchObject({ status: "CREATED" });
  });

  it("stores the PayPal error name on a terminal failure", async () => {
    const { port, deps } = setup();
    port.failNext("reauthorize", { status: 422, name: "UNPROCESSABLE_ENTITY", issues: ["REAUTHORIZATION_TOO_SOON"] });

    const row = await runInline(deps, { businessKey: "reauth:AUTH-6", kind: "reauthorize", mode: "deferred", request: { authorizationId: "AUTH-6", amountCents: "1000" } });

    expect(row.status).toBe("failed_terminal");
    expect(row.httpStatus).toBe(422);
    expect(row.errorName).toBe("UNPROCESSABLE_ENTITY");
  });

  it("sends a non-observable write straight back to pending after a timeout, without a GET", async () => {
    const { port, deps } = setup();
    port.failNext("create_order", "timeout_before_apply");
    const args: EnqueueArgs = { businessKey: "order:PLEDGE-1", kind: "create_order", mode: "inline", request: { amountCents: "1000", customId: "h", invoiceId: "inv-1", funding: "paypal_wallet" } };

    const row = await runInline(deps, args);

    expect(row.status).toBe("pending");
    expect(row.nextAttemptAt.getTime()).toBe(T0.getTime() + backoffMs(1));
    expect(port.calls).toHaveLength(1);
  });
});

describe("outbox: retry, backoff and giving up", () => {
  it("computes backoff as min(5 minutes, 1s * 2^(attempts-1))", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(4)).toBe(8_000);
    expect(backoffMs(9)).toBe(256_000);
    expect(backoffMs(10)).toBe(300_000);
    expect(backoffMs(40)).toBe(300_000);
    expect(MAX_ATTEMPTS).toBe(8);
  });

  it("429 goes back to pending at now + backoffMs(attempts), and after MAX_ATTEMPTS becomes failed_terminal with no further sends", async () => {
    const { port, deps } = setup();
    port.seedAuthorization({ authorizationId: "AUTH-7", amountCents: "1000" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) port.failNext("capture", "http_429");
    const args = captureArgs("AUTH-7");

    let row = await runInline(deps, args);
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      expect(row.status, `attempt ${attempt}`).toBe("pending");
      expect(row.attempts).toBe(attempt);
      expect(row.nextAttemptAt.getTime()).toBe(clock.getTime() + backoffMs(attempt));
      clock = new Date(clock.getTime() + MINUTES(10));
      const claimed = await claimOne(deps.db, row.id, now());
      expect(claimed, `claim ${attempt + 1}`).not.toBeNull();
      row = await paypalCall(deps, claimed!);
    }

    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.status).toBe("failed_terminal");
    expect(port.calls).toHaveLength(MAX_ATTEMPTS);
    clock = new Date(clock.getTime() + MINUTES(600));
    expect(await claimOne(deps.db, row.id, now())).toBeNull();
    expect(port.authorization("AUTH-7")).toMatchObject({ status: "CREATED" });
  });

  it("does not claim a pending row before its next_attempt_at", async () => {
    const { deps } = setup();
    const args = captureArgs("AUTH-LATER");
    const row = await enqueueOp(deps.db, args);
    await completeOp(deps.db, row.id, { status: "pending", nextAttemptAt: new Date(T0.getTime() + MINUTES(5)) });

    expect(await claimOne(deps.db, row.id, now())).toBeNull();
    expect(await claimOne(deps.db, row.id, new Date(T0.getTime() + MINUTES(5)))).not.toBeNull();
  });
});

describe("outbox claiming (own database, so other tests' pending rows can't leak in)", () => {
  let claimFresh: Awaited<ReturnType<typeof createFreshDatabase>>;
  let claimHandle: ReturnType<typeof createDb>;

  beforeAll(async () => {
    claimFresh = await createFreshDatabase();
    await runMigrations(claimFresh.url);
    claimHandle = createDb(claimFresh.url, { max: 5 });
  });
  afterAll(async () => {
    await claimHandle?.close();
    await claimFresh?.drop();
  });

  it("splits rows between two concurrent claimDue callers with no overlap, locks them for 30 s, and skips rows not yet due", async () => {
    const db = claimHandle.db;
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await enqueueOp(db, captureArgs(`CLAIM-${i}`))).id);
    const later = await enqueueOp(db, captureArgs("CLAIM-LATER"));
    await completeOp(db, later.id, { status: "pending", nextAttemptAt: new Date(T0.getTime() + MINUTES(5)) });

    const [a, b] = await Promise.all([claimDue(db, T0, 6), claimDue(db, T0, 6)]);

    const claimed = [...a, ...b].map((r) => r.id);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect([...claimed].sort()).toEqual([...ids].sort());
    for (const row of [...a, ...b]) {
      expect(row.status).toBe("in_flight");
      expect(row.attempts).toBe(1);
      expect(row.lockedUntil!.getTime()).toBe(T0.getTime() + 30_000);
    }
    expect(await claimDue(db, T0, 6)).toEqual([]);
    // `later` lives in this describe's own database, not the suite's main one.
    const [laterNow] = await db.select().from(paypalOps).where(eq(paypalOps.id, later.id));
    expect(laterNow!.status).toBe("pending");
  });

  it("markStaleInFlight turns expired locks into unknown and leaves live locks and finished rows alone", async () => {
    const db = claimHandle.db;
    const rows = await db.select().from(paypalOps).where(like(paypalOps.businessKey, "capture:CLAIM-%"));
    const inFlight = rows.filter((r) => r.status === "in_flight");
    expect(inFlight).toHaveLength(10);
    await completeOp(db, inFlight[0]!.id, { status: "succeeded", httpStatus: 201, response: {} });

    expect(await markStaleInFlight(db, new Date(T0.getTime() + 10_000))).toBe(0);
    expect(await markStaleInFlight(db, new Date(T0.getTime() + 31_000))).toBe(9);

    const after = await db.select().from(paypalOps).where(like(paypalOps.businessKey, "capture:CLAIM-%"));
    expect(after.filter((r) => r.status === "unknown")).toHaveLength(9);
    expect(after.find((r) => r.id === inFlight[0]!.id)!.status).toBe("succeeded");
  });
});
