import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbRoundSnapshot, at, DAY, HOUR, MINUTE, NOW, NOW_MS } from "../../test/policy-arbitraries.ts";
import { coalitionLimit } from "./clearing.ts";
import { cents } from "./money.ts";
import { evaluateRound, type AuthorizationSnapshot, type Decision, type PledgeSnapshot, type RoundSnapshot } from "./settlement.ts";

const RUNS = { numRuns: 500 };

// Contract definitions, restated so the properties do not trust the code under test.
type LivePledge = PledgeSnapshot & { authorization: AuthorizationSnapshot };
const isLive = (p: PledgeSnapshot, now: Date): p is LivePledge =>
  p.authorization !== null && p.authorization.status === "created" && now.getTime() < p.authorization.expiresAt.getTime();
const livePledges = (s: RoundSnapshot, now: Date): LivePledge[] => s.pledges.filter((p): p is LivePledge => isLive(p, now));
const liveAuthIds = (s: RoundSnapshot, now: Date) => livePledges(s, now).map((p) => p.authorization.authorizationId).sort();
const participantsAt = (s: RoundSnapshot, now: Date, price: bigint) =>
  livePledges(s, now).filter((p) => p.mandate.maxUnitPriceCents >= price && p.mandate.deadlineAt.getTime() > now.getTime());
const meetsQuorum = (s: RoundSnapshot, members: PledgeSnapshot[]) =>
  members.reduce((sum, p) => sum + p.mandate.qtyMax, 0) >= s.targetQty && members.length >= s.minMembers;
const sorted = (ids: string[]) => [...ids].sort();

function livePledgeOf(s: RoundSnapshot, pledgeId: string): LivePledge {
  const p = s.pledges.find((x) => x.pledgeId === pledgeId);
  if (p === undefined || !isLive(p, NOW)) throw new Error(`${pledgeId} is not a live pledge of the snapshot`);
  return p;
}

/** Runs fn on every settle decision a locked snapshot produces. */
function forEverySettle(fn: (s: RoundSnapshot, plan: Extract<Decision, { kind: "settle" }>["plan"]) => void) {
  fc.assert(
    fc.property(arbRoundSnapshot({ status: "locked" }), (s) => {
      const d = evaluateRound(s, NOW);
      if (d.kind === "settle") fn(s, d.plan);
    }),
    RUNS,
  );
}

describe("evaluateRound: policy invariants (ARCHITECTURE §6)", () => {
  it("invariant 1: capture never exceeds the authorized amount", () => {
    forEverySettle((s, plan) => {
      for (const c of plan.captures) {
        const p = livePledgeOf(s, c.pledgeId);
        expect(c.authorizationId).toBe(p.authorization.authorizationId);
        expect(c.amountCents <= p.authorization.amountCents, `${c.pledgeId}: ${c.amountCents} > ${p.authorization.amountCents}`).toBe(true);
      }
    });
  });

  it("invariant 2: the settle price is the accepted price and within every captured member's ceiling", () => {
    forEverySettle((s, plan) => {
      expect(plan.unitPriceCents).toBe(s.finalUnitPriceCents);
      for (const c of plan.captures) {
        expect(plan.unitPriceCents <= livePledgeOf(s, c.pledgeId).mandate.maxUnitPriceCents, c.pledgeId).toBe(true);
      }
    });
  });

  it("invariant 3: settle only when Σ qty ≥ targetQty and captures ≥ minMembers (and within supplyCap)", () => {
    forEverySettle((s, plan) => {
      expect(plan.totalQty).toBeGreaterThanOrEqual(s.targetQty);
      expect(plan.captures.length).toBeGreaterThanOrEqual(s.minMembers);
      if (s.supplyCap !== undefined) expect(plan.totalQty).toBeLessThanOrEqual(s.supplyCap);
    });
  });

  it("invariant 4: captured qty is within [qtyMin, qtyMax]; released pledges are voided, never captured", () => {
    forEverySettle((s, plan) => {
      const price = plan.unitPriceCents;
      for (const c of plan.captures) {
        const { qtyMin, qtyMax } = livePledgeOf(s, c.pledgeId).mandate;
        expect(Number.isInteger(c.qty), c.pledgeId).toBe(true);
        expect(c.qty).toBeGreaterThanOrEqual(qtyMin);
        expect(c.qty).toBeLessThanOrEqual(qtyMax);
      }
      for (const p of livePledges(s, NOW)) {
        const captured = plan.captures.some((c) => c.pledgeId === p.pledgeId);
        const release = plan.voids.find((v) => v.pledgeId === p.pledgeId);
        expect(captured && release !== undefined, `${p.pledgeId} both captured and voided`).toBe(false);
        const allowed: string[] = [];
        if (p.mandate.maxUnitPriceCents < price) allowed.push("below_price");
        if (p.mandate.deadlineAt.getTime() <= NOW_MS) allowed.push("mandate_expired");
        if (allowed.length > 0) {
          expect(captured, `${p.pledgeId} should be released`).toBe(false);
          expect(allowed, p.pledgeId).toContain(release?.reason);
        } else if (release !== undefined) {
          expect(release.reason, p.pledgeId).toBe("authorization_too_small");
          expect(price * BigInt(p.mandate.qtyMax) > p.authorization.amountCents, `${p.pledgeId} fits but was released`).toBe(true);
        }
      }
    });
  });

  it("invariant 5: totalCents = price × totalQty exactly, and = Σ capture amounts", () => {
    forEverySettle((s, plan) => {
      for (const c of plan.captures) expect(c.amountCents, c.pledgeId).toBe(plan.unitPriceCents * BigInt(c.qty));
      expect(plan.totalQty).toBe(plan.captures.reduce((sum, c) => sum + c.qty, 0));
      expect(plan.totalCents).toBe(plan.captures.reduce((sum, c) => sum + c.amountCents, 0n));
      expect(plan.totalCents).toBe(plan.unitPriceCents * BigInt(plan.totalQty));
    });
  });

  it("invariant 6: every live authorization ends in exactly one capture or void; non-live ones are never touched", () => {
    fc.assert(
      fc.property(arbRoundSnapshot(), (s) => {
        const d = evaluateRound(s, NOW);
        const live = liveAuthIds(s, NOW);
        if (d.kind === "settle") {
          const touched = [...d.plan.captures, ...d.plan.voids];
          expect(sorted(touched.map((t) => t.authorizationId))).toEqual(live);
          for (const t of touched) expect(t.authorizationId).toBe(livePledgeOf(s, t.pledgeId).authorization.authorizationId);
        }
        if (d.kind === "abort") {
          expect(sorted(d.voids.map((v) => v.authorizationId))).toEqual(live);
          for (const v of d.voids) expect(v.authorizationId).toBe(livePledgeOf(s, v.pledgeId).authorization.authorizationId);
        }
      }),
      RUNS,
    );
  });

  it("invariant 7: never captures past a mandate deadline or honor end; a participant past honor forces reauth", () => {
    fc.assert(
      fc.property(arbRoundSnapshot({ status: "locked" }), (s) => {
        const d = evaluateRound(s, NOW);
        if (d.kind === "settle") {
          for (const c of d.plan.captures) {
            const p = livePledgeOf(s, c.pledgeId);
            expect(p.mandate.deadlineAt.getTime() > NOW_MS, `${c.pledgeId} mandate expired`).toBe(true);
            expect(NOW_MS < p.authorization.honorEndsAt.getTime(), `${c.pledgeId} past honor`).toBe(true);
          }
        }
        if (s.finalUnitPriceCents === null) return;
        const participants = participantsAt(s, NOW, s.finalUnitPriceCents);
        const pastHonor = participants.filter((p) => NOW_MS >= p.authorization.honorEndsAt.getTime());
        if (pastHonor.length === 0) return;
        expect(d.kind).not.toBe("settle");
        if (meetsQuorum(s, participants)) {
          expect(d).toEqual({ kind: "reauth", authorizationIds: sorted(pastHonor.map((p) => p.authorization.authorizationId)) });
        }
      }),
      RUNS,
    );
  });

  it("invariant 10: same snapshot and now give a deep-equal decision, and the input is not mutated", () => {
    fc.assert(
      fc.property(arbRoundSnapshot(), (s) => {
        const before = structuredClone(s);
        const first = evaluateRound(s, NOW);
        const second = evaluateRound(structuredClone(s), new Date(NOW_MS));
        expect(second).toEqual(first);
        expect(s).toEqual(before);
      }),
      RUNS,
    );
  });
});

describe("evaluateRound: contract rules", () => {
  it("only open and locked rounds act; open waits until the pledge deadline, then aborts with the right reason", () => {
    fc.assert(
      fc.property(arbRoundSnapshot(), (s) => {
        const d = evaluateRound(s, NOW);
        if (s.status !== "open" && s.status !== "locked") return void expect(d).toEqual({ kind: "noop" });
        if (s.status === "open" && NOW_MS < s.pledgeDeadlineAt.getTime()) return void expect(d).toEqual({ kind: "wait", reason: "pledging" });
        if (s.status === "locked" && s.finalUnitPriceCents !== null) return;
        // open past its deadline, or locked without an accepted price
        const bids = livePledges(s, NOW).map((p) => ({ pledgeId: p.pledgeId, maxUnitPriceCents: p.mandate.maxUnitPriceCents, qtyMax: p.mandate.qtyMax }));
        const reason = coalitionLimit(bids, { targetQty: s.targetQty, minMembers: s.minMembers }) === null ? "no_quorum" : "no_deal";
        expect(d.kind).toBe("abort");
        if (d.kind === "abort") expect(d.reason).toBe(reason);
      }),
      RUNS,
    );
  });

  it("captures and voids are each sorted by pledgeId", () => {
    forEverySettle((_s, plan) => {
      const captureIds = plan.captures.map((c) => c.pledgeId);
      const voidIds = plan.voids.map((v) => v.pledgeId);
      expect(captureIds).toEqual(sorted(captureIds));
      expect(voidIds).toEqual(sorted(voidIds));
    });
  });

  it("the shared generator reaches every decision kind and every release reason", () => {
    const decisions = fc.sample(arbRoundSnapshot(), { numRuns: 3_000, seed: 7 }).map((s) => evaluateRound(s, NOW));
    const kinds = new Set(decisions.map((d) => (d.kind === "abort" ? `abort:${d.reason}` : d.kind)));
    expect([...kinds].sort()).toEqual(["abort:no_deal", "abort:no_quorum", "noop", "reauth", "settle", "wait"]);
    const reasons = new Set(decisions.flatMap((d) => (d.kind === "settle" ? d.plan.voids.map((v) => v.reason) : [])));
    expect([...reasons].sort()).toEqual(["authorization_too_small", "below_price", "mandate_expired"]);
  });
});

// Named examples: the cases the demo video shows.
function pledge(
  id: string,
  o: { max: number; qtyMin: number; qtyMax: number; auth: number | null; deadlineAt?: Date; honorEndsAt?: Date },
): PledgeSnapshot {
  return {
    pledgeId: id,
    mandate: { memberId: `m-${id}`, maxUnitPriceCents: cents(o.max), qtyMin: o.qtyMin, qtyMax: o.qtyMax, deadlineAt: o.deadlineAt ?? at(DAY) },
    status: o.auth === null ? "order_created" : "authorized",
    authorization:
      o.auth === null
        ? null
        : { authorizationId: `auth-${id}`, amountCents: cents(o.auth), status: "created", honorEndsAt: o.honorEndsAt ?? at(48 * HOUR), expiresAt: at(28 * DAY) },
  };
}

function lockedRound(pledges: PledgeSnapshot[]): RoundSnapshot {
  return { roundId: "round-demo", status: "locked", targetQty: 10, minMembers: 2, pledgeDeadlineAt: at(-HOUR), finalUnitPriceCents: cents(1_000), pledges };
}

describe("evaluateRound: named examples", () => {
  it("quorum missed at the deadline: abort no_quorum and void every live authorization", () => {
    const round: RoundSnapshot = {
      roundId: "round-demo",
      status: "open",
      targetQty: 10,
      minMembers: 2,
      pledgeDeadlineAt: at(-MINUTE),
      finalUnitPriceCents: null,
      pledges: [
        pledge("p-a", { max: 1_200, qtyMin: 1, qtyMax: 3, auth: 3_600 }),
        pledge("p-b", { max: 1_100, qtyMin: 1, qtyMax: 2, auth: 2_200 }),
        pledge("p-c", { max: 1_300, qtyMin: 1, qtyMax: 4, auth: null }), // never approved: ignored
      ],
    };
    expect(evaluateRound(round, NOW)).toEqual({
      kind: "abort",
      reason: "no_quorum",
      voids: [
        { pledgeId: "p-a", authorizationId: "auth-p-a" },
        { pledgeId: "p-b", authorizationId: "auth-p-b" },
      ],
    });
  });

  it("a low-ceiling member is released while quorum still holds: settle, with that pledge voided below_price", () => {
    const round = lockedRound([
      pledge("p-a", { max: 1_200, qtyMin: 2, qtyMax: 5, auth: 6_000 }),
      pledge("p-b", { max: 1_100, qtyMin: 3, qtyMax: 6, auth: 6_600 }),
      pledge("p-c", { max: 900, qtyMin: 1, qtyMax: 4, auth: 3_600 }),
    ]);
    expect(evaluateRound(round, NOW)).toEqual({
      kind: "settle",
      plan: {
        unitPriceCents: 1_000n,
        captures: [
          { pledgeId: "p-a", authorizationId: "auth-p-a", qty: 5, amountCents: 5_000n },
          { pledgeId: "p-b", authorizationId: "auth-p-b", qty: 6, amountCents: 6_000n },
        ],
        voids: [{ pledgeId: "p-c", authorizationId: "auth-p-c", reason: "below_price" }],
        totalQty: 11,
        totalCents: 11_000n,
      },
    });
  });

  it("a participant past its honor period: reauth that authorization instead of settling", () => {
    const round = lockedRound([
      pledge("p-a", { max: 1_200, qtyMin: 2, qtyMax: 5, auth: 6_000 }),
      pledge("p-b", { max: 1_100, qtyMin: 3, qtyMax: 6, auth: 6_600, honorEndsAt: at(-HOUR) }),
      pledge("p-c", { max: 900, qtyMin: 1, qtyMax: 4, auth: 3_600, honorEndsAt: at(-HOUR) }), // below price: not a participant
    ]);
    expect(evaluateRound(round, NOW)).toEqual({ kind: "reauth", authorizationIds: ["auth-p-b"] });
  });
});
