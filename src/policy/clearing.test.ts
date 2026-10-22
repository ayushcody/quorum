import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pledgeIdOf } from "../../test/policy-arbitraries.ts";
import { coalitionLimit, type Bid, type Quorum } from "./clearing.ts";
import { cents } from "./money.ts";

const RUNS = { numRuns: 500 };

// Few distinct prices so ties at the limit are common.
const arbBid: fc.Arbitrary<Bid> = fc.record({
  pledgeId: fc.integer({ min: 0, max: 99 }).map(pledgeIdOf),
  maxUnitPriceCents: fc.bigInt({ min: 1n, max: 30n }).map((d) => cents(d * 100n)),
  qtyMax: fc.integer({ min: 1, max: 10 }),
});
const arbBids = fc.uniqueArray(arbBid, { selector: (b) => b.pledgeId, maxLength: 10 });
const arbQuorum: fc.Arbitrary<Quorum> = fc.record({ targetQty: fc.integer({ min: 1, max: 40 }), minMembers: fc.integer({ min: 1, max: 4 }) });

const coalitionAt = (bids: Bid[], price: bigint) => bids.filter((b) => b.maxUnitPriceCents >= price);
const meetsQuorum = (members: Bid[], q: Quorum) =>
  members.reduce((sum, b) => sum + b.qtyMax, 0) >= q.targetQty && members.length >= q.minMembers;

describe("coalitionLimit", () => {
  it("returns a bid price whose coalition meets quorum, with participants = the sorted ids at or above it", () => {
    fc.assert(
      fc.property(arbBids, arbQuorum, (bids, quorum) => {
        const result = coalitionLimit(bids, quorum);
        if (result === null) return;
        expect(bids.map((b) => b.maxUnitPriceCents)).toContain(result.limitCents);
        const coalition = coalitionAt(bids, result.limitCents);
        expect(meetsQuorum(coalition, quorum)).toBe(true);
        expect(result.participants).toEqual(coalition.map((b) => b.pledgeId).sort());
      }),
      RUNS,
    );
  });

  it("no higher candidate price meets quorum, and null means no candidate does", () => {
    fc.assert(
      fc.property(arbBids, arbQuorum, (bids, quorum) => {
        const result = coalitionLimit(bids, quorum);
        const floor = result === null ? 0n : result.limitCents;
        for (const candidate of bids.map((b) => b.maxUnitPriceCents)) {
          if (candidate > floor) expect(meetsQuorum(coalitionAt(bids, candidate), quorum), `candidate ${candidate}`).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it("adding a bid never lowers the limit (§6.8: an extra pledge never lowers L)", () => {
    fc.assert(
      fc.property(arbBids, arbBid, arbQuorum, (bids, extra, quorum) => {
        fc.pre(!bids.some((b) => b.pledgeId === extra.pledgeId));
        const before = coalitionLimit(bids, quorum);
        const after = coalitionLimit([...bids, extra], quorum);
        if (before === null) return;
        expect(after).not.toBeNull();
        expect(after !== null && after.limitCents >= before.limitCents).toBe(true);
      }),
      RUNS,
    );
  });

  it("picks the highest price the group can clear at", () => {
    const bids: Bid[] = [
      { pledgeId: "p-c", maxUnitPriceCents: cents(900), qtyMax: 4 },
      { pledgeId: "p-a", maxUnitPriceCents: cents(1200), qtyMax: 5 },
      { pledgeId: "p-b", maxUnitPriceCents: cents(1100), qtyMax: 6 },
    ];
    expect(coalitionLimit(bids, { targetQty: 10, minMembers: 2 })).toEqual({ limitCents: 1100n, participants: ["p-a", "p-b"] });
    expect(coalitionLimit(bids, { targetQty: 12, minMembers: 2 })).toEqual({ limitCents: 900n, participants: ["p-a", "p-b", "p-c"] });
    expect(coalitionLimit(bids, { targetQty: 16, minMembers: 2 })).toBeNull();
    expect(coalitionLimit(bids, { targetQty: 1, minMembers: 4 })).toBeNull();
  });
});
