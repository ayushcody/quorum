import { desc, eq, inArray } from "drizzle-orm";
import { cents, type AuthorizationStatus, type PledgeStatus, type RoundSnapshot, type RoundStatus } from "../policy/index.ts";
import type { Executor } from "./client.ts";
import { authorizations, mandates, pledges, rounds } from "./schema.ts";

// Loads what policy.evaluateRound needs for one round. Read-only: deciding and acting stay elsewhere.
export async function loadRoundSnapshot(db: Executor, roundId: string): Promise<RoundSnapshot | undefined> {
  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
  if (!round) return undefined;
  const rows = await db.select({ pledge: pledges, mandate: mandates }).from(pledges).innerJoin(mandates, eq(mandates.id, pledges.mandateId)).where(eq(pledges.roundId, roundId));
  const auths = rows.length === 0 ? [] : await db.select().from(authorizations).where(inArray(authorizations.pledgeId, rows.map((r) => r.pledge.id))).orderBy(desc(authorizations.createdAt));

  return {
    roundId: round.id,
    status: round.status as RoundStatus,
    targetQty: round.targetQty,
    minMembers: round.minMembers,
    pledgeDeadlineAt: round.pledgeDeadlineAt,
    finalUnitPriceCents: round.finalUnitPriceCents === null ? null : cents(round.finalUnitPriceCents),
    pledges: rows.map(({ pledge, mandate }) => {
      // After a reauthorization the parent row is `reauthorized`; the live hold is the newest other one.
      const mine = auths.filter((a) => a.pledgeId === pledge.id);
      const auth = mine.find((a) => a.status !== "reauthorized") ?? mine[0];
      return {
        pledgeId: pledge.id,
        status: pledge.status as PledgeStatus,
        mandate: { memberId: mandate.memberId, maxUnitPriceCents: cents(mandate.maxUnitPriceCents), qtyMin: mandate.qtyMin, qtyMax: mandate.qtyMax, deadlineAt: mandate.deadlineAt },
        authorization: auth
          ? { authorizationId: auth.paypalAuthorizationId, amountCents: cents(auth.amountCents), status: auth.status as AuthorizationStatus, honorEndsAt: auth.honorEndsAt, expiresAt: auth.paypalExpiresAt }
          : null,
      };
    }),
  };
}
