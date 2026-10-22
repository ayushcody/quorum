import fc from "fast-check";
import type { Mandate } from "../src/policy/mandate.ts";
import { cents, type Cents } from "../src/policy/money.ts";
import type { AuthorizationSnapshot, PledgeSnapshot, RoundSnapshot } from "../src/policy/settlement.ts";
import { ROUND_STATES, type AuthorizationStatus, type PledgeStatus, type RoundStatus } from "../src/policy/state.ts";

// Shared fast-check arbitraries for src/policy/*.test.ts. Lives outside src/ so the
// policy-pure boundary scan never sees the fast-check import.

// Fixed clock for every policy test: 2026-01-15T12:00:00Z. Never Date.now().
export const NOW_MS = 1_768_478_400_000;
export const NOW = new Date(NOW_MS);
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const HONOR_MS = 72 * HOUR; // PayPal honor period after authorization
export const EXPIRY_MS = 29 * DAY; // PayPal authorization validity

export const at = (offsetMs: number): Date => new Date(NOW_MS + offsetMs);

export const pledgeIdOf = (n: number): string => `p${String(n).padStart(2, "0")}`;

/** n distinct pledge ids like "p07", in random (not sorted) order. */
export const arbPledgeIds = (n: number): fc.Arbitrary<string[]> =>
  fc.uniqueArray(fc.integer({ min: 0, max: 99 }), { minLength: n, maxLength: n }).map((ns) => ns.map(pledgeIdOf));

// A mandate ceiling around the final price: sometimes exactly on it, otherwise within ±30%.
const arbCeiling = (price: bigint): fc.Arbitrary<bigint> =>
  fc.oneof(
    { weight: 1, arbitrary: fc.constant(price) },
    {
      weight: 4,
      arbitrary: fc.integer({ min: -30, max: 30 }).map((pct) => {
        const ceiling = (price * BigInt(100 + pct)) / 100n;
        return ceiling < 1n ? 1n : ceiling;
      }),
    },
  );

// Mandate deadline on either side of now. Offset 0 (deadline === now) counts as expired.
const arbMandateDeadline: fc.Arbitrary<Date> = fc
  .oneof(
    { weight: 1, arbitrary: fc.integer({ min: -2 * DAY, max: 0 }) },
    { weight: 4, arbitrary: fc.integer({ min: 1, max: 3 * DAY }) },
  )
  .map(at);

// Age of a still-valid authorization: mostly inside the honor period, sometimes past it
// (age === HONOR_MS means honorEndsAt === now, which is past honor).
const arbValidAge: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: HONOR_MS - 1 }) },
  { weight: 1, arbitrary: fc.integer({ min: HONOR_MS, max: EXPIRY_MS - 1 }) },
);

const NON_CREATED: AuthorizationStatus[] = ["captured", "voided", "expired", "denied", "reauthorized"];

const PLEDGE_STATUS_FOR: Record<AuthorizationStatus, PledgeStatus> = {
  created: "authorized",
  captured: "captured",
  voided: "voided",
  expired: "authorized",
  denied: "authorized",
  reauthorized: "reauthorizing",
};

function buildAuthorization(authorizationId: string, status: AuthorizationStatus, ageMs: number, amountCents: Cents): AuthorizationSnapshot {
  const createdMs = NOW_MS - ageMs;
  return {
    authorizationId,
    amountCents,
    status,
    honorEndsAt: new Date(createdMs + HONOR_MS),
    expiresAt: new Date(createdMs + EXPIRY_MS),
  };
}

/**
 * Live (created, before expiresAt) most of the time; otherwise expired by time,
 * in a non-created status, or missing. The amount usually covers the full exposure
 * and sometimes falls short of it.
 */
function arbAuthorization(authorizationId: string, exposure: bigint): fc.Arbitrary<AuthorizationSnapshot | null> {
  const amount = fc
    .oneof({ weight: 4, arbitrary: fc.constant(exposure) }, { weight: 1, arbitrary: fc.bigInt({ min: 1n, max: exposure }) })
    .map((a) => cents(a));
  return fc.oneof(
    { weight: 6, arbitrary: fc.tuple(arbValidAge, amount).map(([age, a]) => buildAuthorization(authorizationId, "created", age, a)) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.integer({ min: EXPIRY_MS, max: EXPIRY_MS + 2 * DAY }), amount)
        .map(([age, a]) => buildAuthorization(authorizationId, "created", age, a)),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.constantFrom(...NON_CREATED), fc.integer({ min: 0, max: EXPIRY_MS - 1 }), amount)
        .map(([status, age, a]) => buildAuthorization(authorizationId, status, age, a)),
    },
    { weight: 1, arbitrary: fc.constant(null) },
  );
}

function arbPledge(pledgeId: string, price: bigint): fc.Arbitrary<PledgeSnapshot> {
  return fc
    .record({
      ceiling: arbCeiling(price),
      qtyMin: fc.integer({ min: 1, max: 4 }),
      extra: fc.integer({ min: 0, max: 6 }),
      deadlineAt: arbMandateDeadline,
    })
    .chain(({ ceiling, qtyMin, extra, deadlineAt }) => {
      const qtyMax = qtyMin + extra;
      const mandate: Mandate = { memberId: `m-${pledgeId}`, maxUnitPriceCents: cents(ceiling), qtyMin, qtyMax, deadlineAt };
      return arbAuthorization(`auth-${pledgeId}`, ceiling * BigInt(qtyMax)).map(
        (authorization): PledgeSnapshot => ({
          pledgeId,
          mandate,
          status: authorization === null ? "order_created" : PLEDGE_STATUS_FOR[authorization.status],
          authorization,
        }),
      );
    });
}

const OTHER_ROUND_STATES = ROUND_STATES.filter((s) => s !== "open" && s !== "locked");

export type SnapshotOptions = { status?: RoundStatus };

/**
 * A round snapshot evaluated against NOW. Mixes live, expired, non-created and missing
 * authorizations; mandate ceilings around the final price; mandate deadlines and honor
 * ends on either side of now; quorum targets that are sometimes reachable; and an
 * optional supplier cap that is sometimes infeasible.
 */
export function arbRoundSnapshot(options: SnapshotOptions = {}): fc.Arbitrary<RoundSnapshot> {
  const arbStatus: fc.Arbitrary<RoundStatus> =
    options.status !== undefined
      ? fc.constant(options.status)
      : fc.oneof(
          { weight: 5, arbitrary: fc.constant<RoundStatus>("locked") },
          { weight: 3, arbitrary: fc.constant<RoundStatus>("open") },
          { weight: 2, arbitrary: fc.constantFrom(...OTHER_ROUND_STATES) },
        );
  return fc
    .record({
      roundId: fc.constantFrom("round-1", "round-2"),
      status: arbStatus,
      price: fc.bigInt({ min: 100n, max: 5_000n }),
      priceAccepted: fc.oneof({ weight: 10, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
      pledgeDeadlineAt: fc.integer({ min: -2 * DAY, max: 2 * DAY }).map(at),
      count: fc.integer({ min: 0, max: 8 }),
    })
    .chain(({ roundId, status, price, priceAccepted, pledgeDeadlineAt, count }) =>
      arbPledgeIds(count)
        .chain((ids) => fc.tuple(...ids.map((id) => arbPledge(id, price))))
        .chain((pledges) => {
          const sumMax = pledges.reduce((sum, p) => sum + p.mandate.qtyMax, 0);
          return fc
            .record({
              targetQty: fc.integer({ min: 1, max: Math.max(1, sumMax) }),
              minMembers: fc.integer({ min: 2, max: 3 }),
              supplyCap: fc.oneof(
                { weight: 2, arbitrary: fc.constant(undefined) },
                { weight: 1, arbitrary: fc.integer({ min: 1, max: sumMax + 3 }) },
              ),
            })
            .map(({ targetQty, minMembers, supplyCap }): RoundSnapshot => {
              const finalUnitPriceCents = status !== "open" && priceAccepted ? cents(price) : null;
              const snapshot: RoundSnapshot = { roundId, status, targetQty, minMembers, pledgeDeadlineAt, finalUnitPriceCents, pledges };
              if (supplyCap !== undefined) snapshot.supplyCap = supplyCap;
              return snapshot;
            });
        }),
    );
}
