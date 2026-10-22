import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { paypalOps } from "../db/schema.ts";
import type { OpKind, OpState } from "./kinds.ts";
import { requestIdFor } from "./request-id.ts";

// The outbox table (ARCHITECTURE §5). Postgres is the queue: FOR UPDATE SKIP LOCKED hands each due
// row to exactly one worker. Times come from the caller's clock, never the database's.

export type OpRow = typeof paypalOps.$inferSelect;
export type EnqueueArgs = { businessKey: string; kind: OpKind; mode: "inline" | "deferred"; request: object; roundId?: string; pledgeId?: string };

const LOCK_MS = 30_000;
// A new row is due immediately, whatever any clock says.
const DUE_NOW = new Date(0);

// Idempotent: the same business key always maps to the same single row.
export async function enqueueOp(db: Db, args: EnqueueArgs): Promise<OpRow> {
  const [inserted] = await db
    .insert(paypalOps)
    .values({
      businessKey: args.businessKey,
      requestId: requestIdFor(args.businessKey),
      kind: args.kind,
      mode: args.mode,
      request: args.request,
      roundId: args.roundId ?? null,
      pledgeId: args.pledgeId ?? null,
      status: "pending",
      nextAttemptAt: DUE_NOW,
    })
    .onConflictDoNothing({ target: paypalOps.businessKey })
    .returning();
  if (inserted) return inserted;
  const [existing] = await db.select().from(paypalOps).where(eq(paypalOps.businessKey, args.businessKey));
  return existing!;
}

const claimSet = (now: Date) => ({
  status: "in_flight" as const,
  lockedUntil: new Date(now.getTime() + LOCK_MS),
  attempts: sql`${paypalOps.attempts} + 1`,
  updatedAt: now,
});

export async function claimDue(db: Db, now: Date, limit: number): Promise<OpRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: paypalOps.id })
      .from(paypalOps)
      .where(and(eq(paypalOps.status, "pending"), lte(paypalOps.nextAttemptAt, now)))
      .orderBy(paypalOps.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx.update(paypalOps).set(claimSet(now)).where(inArray(paypalOps.id, due.map((d) => d.id))).returning();
  });
}

// The inline path: claim one known row, if it is pending and due. A single conditional UPDATE, so
// two callers can't both win it.
export async function claimOne(db: Db, id: string, now: Date): Promise<OpRow | null> {
  const [row] = await db
    .update(paypalOps)
    .set(claimSet(now))
    .where(and(eq(paypalOps.id, id), eq(paypalOps.status, "pending"), lte(paypalOps.nextAttemptAt, now)))
    .returning();
  return row ?? null;
}

export async function completeOp(
  db: Db,
  id: string,
  result: { status: OpState; httpStatus?: number | null; response?: unknown; errorName?: string | null; debugId?: string | null; nextAttemptAt?: Date },
): Promise<OpRow> {
  const [row] = await db
    .update(paypalOps)
    .set({
      status: result.status,
      lockedUntil: null,
      updatedAt: sql`now()`,
      ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
      ...(result.response !== undefined ? { response: result.response } : {}),
      ...(result.errorName !== undefined ? { errorName: result.errorName } : {}),
      ...(result.debugId !== undefined ? { paypalDebugId: result.debugId } : {}),
      ...(result.nextAttemptAt !== undefined ? { nextAttemptAt: result.nextAttemptAt } : {}),
    })
    .where(eq(paypalOps.id, id))
    .returning();
  return row!;
}

// A worker that died mid-call leaves its row in_flight; once the lock lapses the outcome is unknown,
// so it goes to reconcile rather than straight back to pending.
export async function markStaleInFlight(db: Db, now: Date): Promise<number> {
  const rows = await db
    .update(paypalOps)
    .set({ status: "unknown", lockedUntil: null, updatedAt: now })
    .where(and(eq(paypalOps.status, "in_flight"), lt(paypalOps.lockedUntil, now)))
    .returning({ id: paypalOps.id });
  return rows.length;
}
